require('dotenv').config();

// Pflicht-Umgebungsvariablen prüfen
const required = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'GMAIL_USER', 'GMAIL_APP_PASSWORD'];
required.forEach(key => {
  if (!process.env[key]) throw new Error(`Fehlende Umgebungsvariable: ${key}`);
});

const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const rateLimit = require('express-rate-limit');

// ✅ DATABASE IMPORT
const { 
  initializeTables, 
  createOrder, 
  updateOrderPaymentStatus,
  getOrder,
  createDownloadRecord,
  getDownloadRecord,
  markAsDownloaded,
  logAuditEvent,
  getStats,
  getAllOrders,
  getAuditLogs
} = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Datenbank initialisieren
initializeTables();

// Nodemailer Transporter mit Gmail
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD
  }
});

// Verbindung testen
transporter.verify((error, success) => {
  if (error) {
    console.error('❌ Gmail Verbindungsfehler:', error);
  } else {
    console.log('✅ Gmail Server bereit');
  }
});

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Zu viele Anfragen. Bitte versuche es später erneut.' }
});

// WICHTIG: Webhook muss VOR express.json() kommen!
app.use(cors({ origin: 'https://taghiwaves.onrender.com' }));
app.use(express.static(path.join(__dirname, 'public')));

// Produkte
const products = [
  {
    id: "prod_cheat",
    name: "Mixing EQ Cheat Sheet",
    price: 50,
    description: "Schnellreferenz für EQ-Einstellungen aller Instrumente. PDF-Download."
  }
];

// ============================================
// 🛡️ VALIDIERUNGSFUNKTIONEN
// ============================================

function isValidEmail(email) {
  if (typeof email !== 'string') return false;
  if (email.length > 254) return false;
  
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

function isValidString(str, minLen = 1, maxLen = 500) {
  if (typeof str !== 'string') return false;
  if (str.trim().length < minLen) return false;
  if (str.length > maxLen) return false;
  return true;
}

function validateItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return { valid: false, error: 'Artikel muss ein Objekt sein' };
  }

  const allowedFields = ['name', 'price', 'description'];
  const itemKeys = Object.keys(item);
  const unknownFields = itemKeys.filter(key => !allowedFields.includes(key));
  if (unknownFields.length > 0) {
    return { valid: false, error: `Unbekannte Felder: ${unknownFields.join(', ')}` };
  }

  if (!isValidString(item.name, 1, 100)) {
    return { valid: false, error: 'Name muss 1-100 Zeichen lang sein' };
  }

  if (!isValidString(item.description, 1, 500)) {
    return { valid: false, error: 'Beschreibung muss 1-500 Zeichen lang sein' };
  }

  if (typeof item.price !== 'number') {
    return { valid: false, error: 'Preis muss eine Zahl sein' };
  }

  if (!Number.isInteger(item.price)) {
    return { valid: false, error: 'Preis muss ein ganzer Betrag in Cent sein (z.B. 5000 für 50€)' };
  }

  if (item.price < 50) {
    return { valid: false, error: 'Minimum Preis: 0,50€ (50 Cent)' };
  }

  if (item.price > 9999900) {
    return { valid: false, error: 'Maximum Preis: 99.999,00€' };
  }

  return { valid: true };
}

function validateCheckoutInput(items, customerEmail) {
  if (!Array.isArray(items)) {
    return { valid: false, error: 'items muss ein Array sein' };
  }

  if (items.length === 0) {
    return { valid: false, error: 'Mindestens ein Artikel erforderlich' };
  }

  if (items.length > 10) {
    return { valid: false, error: 'Maximum 10 Artikel pro Bestellung' };
  }

  for (let i = 0; i < items.length; i++) {
    const itemValidation = validateItem(items[i]);
    if (!itemValidation.valid) {
      return { valid: false, error: `Artikel ${i + 1}: ${itemValidation.error}` };
    }
  }

  if (customerEmail) {
    if (!isValidEmail(customerEmail)) {
      return { valid: false, error: 'Ungültige E-Mail Adresse' };
    }
  }

  return { valid: true };
}

// ============================================
// WEBHOOK
// ============================================

app.post('/api/webhook', express.raw({type: 'application/json'}), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error('Webhook Error:', err.message);
    await logAuditEvent('webhook_error', 'Stripe Webhook Signature Fehler', { error: err.message });
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.customer_details?.email || session.customer_email;
    
    console.log('✅ Zahlung erfolgreich:', email);
    
    if (!email) {
      console.error('❌ Keine E-Mail im Session Object gefunden');
      await logAuditEvent('payment_error', 'Keine E-Mail in Webhook', { sessionId: session.id });
      return res.json({received: true});
    }

    try {
      // ✅ Update Order Status in Datenbank
      await updateOrderPaymentStatus(session.id, 'paid');
      console.log('📝 Order Status aktualisiert in DB:', session.id);

      // ✅ Erstelle Download-Record
      await createDownloadRecord(session.id, email);
      console.log('📥 Download-Record erstellt');

      // Sende E-Mail
      await transporter.sendMail({
        from: `"taghiwaves" <${process.env.GMAIL_USER}>`,
        to: email,
        subject: 'Dein taghiwaves Download ist bereit!',
        html: `
          <h1>Vielen Dank für deinen Kauf!</h1>
          <p>Du hast <strong>Mixing EQ Cheat Sheet</strong> erfolgreich gekauft.</p>
          <p><a href="https://taghiwaves.onrender.com/api/download/mixing-eq-guide?session_id=${session.id}" 
                style="background:#00f0ff; color:#000; padding:12px 24px; text-decoration:none; border-radius:8px; display:inline-block; margin:20px 0;">
                Jetzt herunterladen
             </a></p>
          <p>Bei Fragen antworte einfach auf diese E-Mail.</p>
          <br>
          <p>taghiwaves Team</p>
        `
      });
      console.log('📧 E-Mail gesendet an:', email);
      await logAuditEvent('email_sent', 'Download-Link E-Mail versendet', { email, sessionId: session.id });

    } catch (error) {
      console.error('❌ Fehler in Webhook:', error);
      await logAuditEvent('webhook_error', 'Fehler beim Verarbeiten von Webhook', { error: error.message, sessionId: session.id });
    }
  }

  res.json({received: true});
});

// ERST DANACH json parser
app.use(express.json());

// ============================================
// 🛡️ DOWNLOAD-ROUTE MIT DATENBANKPRÜFUNG
// ============================================

app.get('/api/download/mixing-eq-guide', limiter, async (req, res) => {
  const sessionId = req.query.session_id;
  
  if (!sessionId) {
    await logAuditEvent('download_denied', 'Kein Session ID vorhanden');
    return res.status(403).send('Zugriff verweigert. Bitte erst kaufen.');
  }
  
  try {
    // ✅ Prüfe Download-Record in Datenbank
    const downloadRecord = await getDownloadRecord(sessionId);
    
    if (!downloadRecord) {
      await logAuditEvent('download_denied', 'Download-Record nicht gefunden', { sessionId });
      return res.status(403).send('Download nicht gefunden.');
    }

    // Prüfe ob bereits heruntergeladen
    if (downloadRecord.downloaded) {
      await logAuditEvent('download_denied', 'Download bereits verwendet', { sessionId, email: downloadRecord.email });
      return res.status(403).send(`
        <html>
          <head><title>Download bereits genutzt</title></head>
          <body style="font-family: Arial; text-align: center; padding: 50px; background: #0a0a0f; color: #fff;">
            <h1>⚠️ Download bereits verwendet</h1>
            <p>Dieser Link wurde bereits einmal genutzt.</p>
            <p style="color: #00f0ff;">Bei Problemen kontaktiere uns: hello@taghiwaves.com</p>
          </body>
        </html>
      `);
    }

    // ✅ Prüfe Order Status
    const order = await getOrder(sessionId);
    
    if (!order || order.payment_status !== 'paid') {
      await logAuditEvent('download_denied', 'Zahlung nicht bestätigt', { sessionId });
      return res.status(403).send('Zahlung nicht bestätigt.');
    }
    
    const filePath = path.join(__dirname, 'public', 'downloads', 'mixing-eq-guide.pdf');
    
    // ✅ Prüfe ob Datei existiert
    if (!fs.existsSync(filePath)) {
      console.error('❌ Datei nicht gefunden:', filePath);
      await logAuditEvent('download_error', 'Datei nicht gefunden', { filePath });
      return res.status(404).send(`
        <html>
          <head><title>Datei nicht verfügbar</title></head>
          <body style="font-family: Arial; text-align: center; padding: 50px; background: #0a0a0f; color: #fff;">
            <h1>❌ Datei nicht verfügbar</h1>
            <p>Die Datei konnte nicht gefunden werden. Bitte kontaktiere den Support.</p>
            <p style="color: #00f0ff;">E-Mail: hello@taghiwaves.com</p>
          </body>
        </html>
      `);
    }
    
    // ✅ Markiere als heruntergeladen BEVOR Download startet
    await markAsDownloaded(sessionId);
    console.log('✅ Download gestartet:', sessionId);
    await logAuditEvent('download_success', 'PDF erfolgreich heruntergeladen', { 
      sessionId, 
      email: order.customer_email 
    });
    
    res.download(filePath, 'Mixing-EQ-Cheat-Sheet.pdf');
    
  } catch (error) {
    console.error('❌ Download-Fehler:', error);
    await logAuditEvent('download_error', 'Fehler beim Download', { error: error.message, sessionId });
    res.status(500).send('Download-Fehler: ' + error.message);
  }
});

// ============================================
// API ROUTES
// ============================================

app.get('/api/products', (req, res) => {
  res.json(products);
});

// ============================================
// 🛡️ API: Checkout Session (MIT VALIDIERUNG + DB)
// ============================================

app.post('/api/create-checkout-session', limiter, async (req, res) => {
  try {
    const { items, customerEmail } = req.body;
    
    // ✅ VALIDIERUNG
    const validation = validateCheckoutInput(items, customerEmail);
    if (!validation.valid) {
      console.warn('❌ Validierungsfehler:', validation.error);
      await logAuditEvent('validation_error', validation.error, { items, customerEmail });
      return res.status(400).json({ error: validation.error });
    }
    
    const lineItems = items.map(item => ({
      price_data: {
        currency: 'eur',
        product_data: {
          name: item.name,
          description: item.description,
        },
        unit_amount: item.price,
      },
      quantity: 1,
    }));

    const sessionConfig = {
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      success_url: `${req.headers.origin}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.headers.origin}/cancel.html`,
      automatic_tax: { enabled: true },
    };

    if (customerEmail) {
      sessionConfig.customer_email = customerEmail;
    } else {
      sessionConfig.customer_creation = 'always';
    }

    const session = await stripe.checkout.sessions.create(sessionConfig);
    
    // ✅ Speichere Order in Datenbank
    try {
      await createOrder(
        session.id,
        customerEmail || session.customer_email || 'unknown@email.com',
        items[0].name,
        items[0].price
      );
      console.log('📝 Order in DB erstellt:', session.id);
    } catch (dbError) {
      console.error('❌ Fehler beim Speichern in DB:', dbError);
      await logAuditEvent('database_error', 'Fehler beim Erstellen von Order', { error: dbError.message });
      // Gebe dennoch die Session zurück (Order wird beim Webhook erstellt)
    }

    res.json({ id: session.id });
    
  } catch (error) {
    console.error('Checkout Fehler:', error);
    await logAuditEvent('checkout_error', 'Fehler beim Checkout', { error: error.message });
    res.status(500).json({ error: 'Fehler beim Erstellen der Checkout-Session' });
  }
});

// ============================================
// 📊 ADMIN ROUTES (Optional, für später)
// ============================================

// Statistiken abrufen (vereinfacht, später mit Auth!)
app.get('/api/admin/stats', async (req, res) => {
  try {
    const stats = await getStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Alle Orders anschauen (vereinfacht, später mit Auth!)
app.get('/api/admin/orders', async (req, res) => {
  try {
    const orders = await getAllOrders();
    res.json(orders);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Audit-Logs anschauen (vereinfacht, später mit Auth!)
app.get('/api/admin/logs', async (req, res) => {
  try {
    const logs = await getAuditLogs(100);
    res.json(logs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// HEALTH CHECK
// ============================================

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
  console.log(`🎵 taghiwaves Server läuft auf Port ${PORT}`);
});
