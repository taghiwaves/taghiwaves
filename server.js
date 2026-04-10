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

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ HIER: Download-Tracker (nach const app = express())
const downloadTracker = new Map();

// Hilfsfunktion: Alte Downloads aufräumen
function cleanupOldDownloads() {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  for (const [sessionId, data] of downloadTracker.entries()) {
    if (data.timestamp < thirtyDaysAgo) {
      downloadTracker.delete(sessionId);
    }
  }
}

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
// 🛡️ VALIDIERUNGSFUNKTIONEN (NEU!)
// ============================================

/**
 * Validiert E-Mail Adressen
 * @param {string} email - E-Mail zum Prüfen
 * @returns {boolean}
 */
function isValidEmail(email) {
  if (typeof email !== 'string') return false;
  if (email.length > 254) return false;
  
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Sanitizes und validiert einen String
 * @param {string} str - String zum validieren
 * @param {number} minLen - Minimum Länge
 * @param {number} maxLen - Maximum Länge
 * @returns {boolean}
 */
function isValidString(str, minLen = 1, maxLen = 500) {
  if (typeof str !== 'string') return false;
  if (str.trim().length < minLen) return false;
  if (str.length > maxLen) return false;
  return true;
}

/**
 * Validiert einen Checkout-Artikel
 * @param {object} item - Artikel zum validieren
 * @returns {{valid: boolean, error?: string}}
 */
function validateItem(item) {
  // Muss ein Objekt sein
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return { valid: false, error: 'Artikel muss ein Objekt sein' };
  }

  // Nur erlaubte Felder
  const allowedFields = ['name', 'price', 'description'];
  const itemKeys = Object.keys(item);
  const unknownFields = itemKeys.filter(key => !allowedFields.includes(key));
  if (unknownFields.length > 0) {
    return { valid: false, error: `Unbekannte Felder: ${unknownFields.join(', ')}` };
  }

  // Name validieren
  if (!isValidString(item.name, 1, 100)) {
    return { valid: false, error: 'Name muss 1-100 Zeichen lang sein' };
  }

  // Description validieren
  if (!isValidString(item.description, 1, 500)) {
    return { valid: false, error: 'Beschreibung muss 1-500 Zeichen lang sein' };
  }

  // Price validieren
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

/**
 * Hauptvalidierungsfunktion für Checkout
 * @param {array} items - Array von Artikeln
 * @param {string} customerEmail - Kunden E-Mail
 * @returns {{valid: boolean, error?: string}}
 */
function validateCheckoutInput(items, customerEmail) {
  // Items prüfen
  if (!Array.isArray(items)) {
    return { valid: false, error: 'items muss ein Array sein' };
  }

  if (items.length === 0) {
    return { valid: false, error: 'Mindestens ein Artikel erforderlich' };
  }

  if (items.length > 10) {
    return { valid: false, error: 'Maximum 10 Artikel pro Bestellung' };
  }

  // Jeden Artikel validieren
  for (let i = 0; i < items.length; i++) {
    const itemValidation = validateItem(items[i]);
    if (!itemValidation.valid) {
      return { valid: false, error: `Artikel ${i + 1}: ${itemValidation.error}` };
    }
  }

  // customerEmail validieren wenn vorhanden
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
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.customer_details?.email || session.customer_email;
    
    console.log('✅ Zahlung erfolgreich:', email);
    
    if (!email) {
      console.error('❌ Keine E-Mail im Session Object gefunden');
      return res.json({received: true});
    }

    try {
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
    } catch (error) {
      console.error('❌ E-Mail Fehler:', error);
    }
  }

  res.json({received: true});
});

// ERST DANACH json parser
app.use(express.json());

// ============================================
// 🛡️ DOWNLOAD-ROUTE MIT DATEI-PRÜFUNG (VERBESSERT)
// ============================================

app.get('/api/download/mixing-eq-guide', limiter, async (req, res) => {
  const sessionId = req.query.session_id;
  
  if (!sessionId) {
    return res.status(403).send('Zugriff verweigert. Bitte erst kaufen.');
  }
  
  // Prüfen ob bereits heruntergeladen
  const tracker = downloadTracker.get(sessionId);
  if (tracker?.downloaded) {
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
  
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    
    if (session.payment_status !== 'paid') {
      return res.status(403).send('Zahlung nicht bestätigt.');
    }
    
    const filePath = path.join(__dirname, 'public', 'downloads', 'mixing-eq-guide.pdf');
    
    // ✅ NEU: Prüfe ob Datei existiert BEVOR Download
    if (!fs.existsSync(filePath)) {
      console.error('❌ Datei nicht gefunden:', filePath);
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
    
    // Als heruntergeladen markieren (BEVOR der Download startet)
    downloadTracker.set(sessionId, { 
      downloaded: true, 
      timestamp: new Date(),
      email: session.customer_details?.email || session.customer_email 
    });
    
    // Alte Einträge aufräumen
    cleanupOldDownloads();
    
    res.download(filePath, 'Mixing-EQ-Cheat-Sheet.pdf');
    
  } catch (error) {
    console.error('Download-Fehler:', error);
    res.status(500).send('Download-Fehler: ' + error.message);
  }
});

// ============================================
// API ROUTES
// ============================================

// API: Produkte abrufen
app.get('/api/products', (req, res) => {
  res.json(products);
});

// ============================================
// 🛡️ API: Checkout Session (MIT VALIDIERUNG!)
// ============================================

app.post('/api/create-checkout-session', limiter, async (req, res) => {
  try {
    const { items, customerEmail } = req.body;
    
    // ✅ VALIDIERUNG HINZUGEFÜGT
    const validation = validateCheckoutInput(items, customerEmail);
    if (!validation.valid) {
      console.warn('❌ Validierungsfehler:', validation.error);
      return res.status(400).json({ 
        error: validation.error 
      });
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
    res.json({ id: session.id });
    
  } catch (error) {
    console.error('Checkout Fehler:', error);
    res.status(500).json({ error: 'Fehler beim Erstellen der Checkout-Session' });
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