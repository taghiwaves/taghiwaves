require('dotenv').config();

// Pflicht-Umgebungsvariablen prüfen
const required = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'APP_URL'];
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

// ✅ PERSISTENTER Download-Tracker (JSON-Datei)
const TRACKER_FILE = path.join(__dirname, 'download-tracker.json');

function loadTracker() {
  try {
    if (fs.existsSync(TRACKER_FILE)) {
      const raw = fs.readFileSync(TRACKER_FILE, 'utf8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.error('⚠️ Tracker-Datei konnte nicht geladen werden:', err.message);
  }
  return {};
}

function saveTracker(tracker) {
  try {
    fs.writeFileSync(TRACKER_FILE, JSON.stringify(tracker, null, 2), 'utf8');
  } catch (err) {
    console.error('⚠️ Tracker-Datei konnte nicht gespeichert werden:', err.message);
  }
}

// Beim Start laden
let downloadTracker = loadTracker();

// Hilfsfunktion: Alte Downloads aufräumen
function cleanupOldDownloads() {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  for (const sessionId of Object.keys(downloadTracker)) {
    if (new Date(downloadTracker[sessionId].timestamp) < thirtyDaysAgo) {
      delete downloadTracker[sessionId];
    }
  }
  saveTracker(downloadTracker);
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
    id: "prod_yeni_sesler",
    name: "Yeni səslərin yaradılması",
    price: 50,
    description: "Bir prodüksiyanın səs mənzərəsi kompozisiya və aranjimanla yanaşı həm də musiqi əsərinin xarakterik xüsusiyyətlərindən biri sayıldığı üçün, bir prodüser kimi fərdi səslərə sahib olmağa çalışmaq lazımdır. Bu fəsildə mən sizə öz şəxsi səslərinizi yarada biləcəyiniz bəzi texnikaları göstərirəm.",
    image: "/assets/yeni-sesler.jpg"
  },
  {
    id: "prod_dabstep",
    name: "Dabstep səhnəsindən yeni səslər",
    price: 50,
    description: "Dabstepin (Dubstep) böyük uğuru musiqi dünyasına yeni bir nəfəs gətirdi. Bir tərəfdən, Britaniya andeqraundundan gələn bu musiqi tərzi bizə yeni növ qruvlar (grooves) bəxş etdi. Beləliklə, popdan rəqs musiqisinə, hətta metala qədər, dabstepin o qəribə, ağır sürünən \"halftime\" ritmikası tərəfindən mənimsənilməyən demək olar ki, heç bir janr qalmadı.",
    image: "/assets/dubstep.png"
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
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.customer_details?.email || session.customer_email;
    
    console.log('✅ Zahlung erfolgreich:', email);
    
    if (!email) {
      console.error('❌ Keine E-Mail im Session Object gefunden');
      return res.status(400).json({ error: "Keine E-Mail gefunden" });
    }

    try {
      // Gekauftes Produkt aus Line Items ermitteln
      const lineItems = await stripe.checkout.sessions.listLineItems(session.id);
      const productName = lineItems.data[0]?.description || '';
      
      let downloadUrl = '';
      let productTitle = '';
      if (productName.includes('Dabstep')) {
        downloadUrl = `${process.env.APP_URL}/api/download/dabstep?session_id=${session.id}`;
        productTitle = 'Dabstep səhnəsindən yeni səslər';
      } else {
        downloadUrl = `${process.env.APP_URL}/api/download/yeni-sesler?session_id=${session.id}`;
        productTitle = 'Yeni səslərin yaradılması';
      }

      await transporter.sendMail({
        from: `"taghiwaves" <${process.env.GMAIL_USER}>`,
        to: email,
        subject: 'taghiwaves yükləməyə hazırdır!',
        html: `
          <h1>Satın aldığınız üçün təşəkkür edirik!</h1>
          <p>Siz <strong>${productTitle}</strong> uğurla satın aldınız.</p>
          <p><a href="${downloadUrl}" 
                style="background:#00f0ff; color:#000; padding:12px 24px; text-decoration:none; border-radius:8px; display:inline-block; margin:20px 0;">
                İndi yüklə
             </a></p>
          <p>Suallarınız üçün bu e-poçta cavab verin.</p>
          <br>
          <p>taghiwaves Komandası</p>
        `
      });
      console.log('📧 E-Mail gesendet an:', email);
    } catch (error) {
      console.error('❌ E-Mail Fehler:', error);
      return res.status(500).json({ error: 'E-Mail Versand fehlgeschlagen' });
    }
  }

  res.json({received: true});
});

// ERST DANACH json parser
app.use(express.json());

// ============================================
// 🛡️ DOWNLOAD-ROUTE MIT DATEI-PRÜFUNG
// ============================================

app.get('/api/download/yeni-sesler', limiter, async (req, res) => {
  const sessionId = req.query.session_id;
  
  if (!sessionId) {
    return res.status(403).send('Zugriff verweigert. Bitte erst kaufen.');
  }
  
  // Prüfen ob bereits heruntergeladen
  const tracker = downloadTracker[sessionId];
  if (tracker?.downloaded) {
    return res.status(403).send(`
      <html>
        <head><title>Yükləmə artıq istifadə edilib</title></head>
        <body style="font-family: Arial; text-align: center; padding: 50px; background: #0a0a0f; color: #fff;">
          <h1>⚠️ Yükləmə artıq istifadə edilib</h1>
          <p>Bu link artıq bir dəfə istifadə edilib.</p>
          <p style="color: #00f0ff;">Problemlər üçün bizimlə əlaqə saxlayın: taghiwaves@gmail.com</p>
        </body>
      </html>
    `);
  }
  
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    
    if (session.payment_status !== 'paid') {
      return res.status(403).send('Zahlung nicht bestätigt.');
    }
    
    const filePath = path.join(__dirname, 'public', 'downloads', 'yeni-sesler.pdf');
    
    // ✅ NEU: Prüfe ob Datei existiert BEVOR Download
    if (!fs.existsSync(filePath)) {
      console.error('❌ Datei nicht gefunden:', filePath);
      return res.status(404).send(`
        <html>
          <head><title>Fayl mövcud deyil</title></head>
          <body style="font-family: Arial; text-align: center; padding: 50px; background: #0a0a0f; color: #fff;">
            <h1>❌ Fayl mövcud deyil</h1>
            <p>Fayl tapılmadı. Zəhmət olmasa dəstək xidməti ilə əlaqə saxlayın.</p>
            <p style="color: #00f0ff;">E-poçt: taghiwaves@gmail.com</p>
          </body>
        </html>
      `);
    }
    
    // Als heruntergeladen markieren (BEVOR der Download startet)
    downloadTracker[sessionId] = { 
      downloaded: true, 
      timestamp: new Date(),
      email: session.customer_details?.email || session.customer_email 
    };
    saveTracker(downloadTracker);
    
    // Alte Einträge aufräumen
    cleanupOldDownloads();
    
    res.download(filePath, 'Yeni səslərin yaradılması.pdf');
    
  } catch (error) {
    console.error('Download-Fehler:', error);
    res.status(500).send('Download-Fehler: ' + error.message);
  }
});

app.get('/api/download/dabstep', limiter, async (req, res) => {
  const sessionId = req.query.session_id;
  
  if (!sessionId) {
    return res.status(403).send('Zugriff verweigert. Bitte erst kaufen.');
  }
  
  const tracker = downloadTracker[sessionId];
  if (tracker?.downloaded) {
    return res.status(403).send(`
      <html>
        <head><title>Yükləmə artıq istifadə edilib</title></head>
        <body style="font-family: Arial; text-align: center; padding: 50px; background: #0a0a0f; color: #fff;">
          <h1>⚠️ Yükləmə artıq istifadə edilib</h1>
          <p>Bu link artıq bir dəfə istifadə edilib.</p>
          <p style="color: #00f0ff;">Problemlər üçün bizimlə əlaqə saxlayın: taghiwaves@gmail.com</p>
        </body>
      </html>
    `);
  }
  
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    
    if (session.payment_status !== 'paid') {
      return res.status(403).send('Ödəniş təsdiqlənmədi.');
    }
    
    const filePath = path.join(__dirname, 'public', 'downloads', 'dabstep.pdf');
    
    if (!fs.existsSync(filePath)) {
      console.error('❌ Datei nicht gefunden:', filePath);
      return res.status(404).send(`
        <html>
          <head><title>Fayl mövcud deyil</title></head>
          <body style="font-family: Arial; text-align: center; padding: 50px; background: #0a0a0f; color: #fff;">
            <h1>❌ Fayl mövcud deyil</h1>
            <p>Fayl tapılmadı. Zəhmət olmasa dəstək xidməti ilə əlaqə saxlayın.</p>
            <p style="color: #00f0ff;">E-poçt: taghiwaves@gmail.com</p>
          </body>
        </html>
      `);
    }
    
    downloadTracker[sessionId] = { 
      downloaded: true, 
      timestamp: new Date(),
      email: session.customer_details?.email || session.customer_email 
    };
    saveTracker(downloadTracker);
    cleanupOldDownloads();
    
    res.download(filePath, 'Dabstep səhnəsindən yeni səslər.pdf');
    
  } catch (error) {
    console.error('Download-Fehler:', error);
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
// 🛡️ API: Checkout Session (MIT VALIDIERUNG!)
// ============================================

app.post('/api/create-checkout-session', limiter, async (req, res) => {
  try {
    const { items, customerEmail } = req.body;
    
    // ✅ VALIDIERUNG
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
      success_url: `${process.env.APP_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.APP_URL}/cancel.html`,
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
// PREVIEW ROUTE
// ============================================

const PREVIEW_PRODUCTS = {
  'yeni-sesler': ['yeni-sesler-1.jpg', 'yeni-sesler-2.jpg'],
  'dabstep':     ['dabstep-1.jpg', 'dabstep-2.jpg'],
};

app.get('/api/preview/:productId', limiter, (req, res) => {
  const { productId } = req.params;

  if (!PREVIEW_PRODUCTS[productId]) {
    return res.status(404).json({ error: 'Məhsul tapılmadı.' });
  }

  const images = PREVIEW_PRODUCTS[productId].map(
    filename => `/assets/previews/${filename}`
  );

  res.json({ images });
});

// ============================================
// CONTACT FORM
// ============================================

app.post('/api/contact', limiter, async (req, res) => {
  const { name, email, message } = req.body;

  if (!isValidString(name, 1, 100)) {
    return res.status(400).json({ error: 'Ad düzgün deyil.' });
  }
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'E-poçt ünvanı düzgün deyil.' });
  }
  if (!isValidString(message, 10, 2000)) {
    return res.status(400).json({ error: 'Mesaj ən az 10 simvol olmalıdır.' });
  }

  try {
    await transporter.sendMail({
      from: `"taghiwaves Kontakt" <${process.env.GMAIL_USER}>`,
      to: process.env.GMAIL_USER,
      replyTo: email,
      subject: `📩 Yeni mesaj: ${name}`,
      html: `
        <h2>Yeni əlaqə mesajı</h2>
        <p><strong>Ad:</strong> ${name}</p>
        <p><strong>E-poçt:</strong> ${email}</p>
        <p><strong>Mesaj:</strong></p>
        <p style="background:#f5f5f5; padding:1rem; border-radius:8px;">${message.replace(/\n/g, '<br>')}</p>
      `
    });

    res.json({ success: true });
  } catch (error) {
    console.error('❌ Kontakt E-Mail xətası:', error);
    res.status(500).json({ error: 'Mesaj göndərilə bilmədi. Zəhmət olmasa yenidən cəhd edin.' });
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