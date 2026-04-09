require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const path = require('path');
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Produkte (in Produktion: Datenbank)
const products = [
  {
    id: "prod_cheat",
    name: "Mixing EQ Cheat Sheet",
    price: 99, // 0,99€ in cents
    description: "Schnellreferenz für EQ-Einstellungen aller Instrumente. PDF-Download."
  },
  // ... andere Produkte
];

// Sichere Download-Route (nach erfolgreicher Zahlung)
app.get('/api/download/:productId', async (req, res) => {
  const sessionId = req.query.session_id;
  
  if (!sessionId) {
    return res.status(403).send('Zugriff verweigert. Bitte erst kaufen.');
  }
  
  try {
    // Prüfe ob Zahlung erfolgreich war
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    
    if (session.payment_status !== 'paid') {
      return res.status(403).send('Zahlung nicht bestätigt.');
    }
    
    // Sende Datei
    const filePath = path.join(__dirname, 'public', 'downloads', 'mixing-eq-guide.pdf');
    res.download(filePath, 'Mixing-EQ-Cheat-Sheet.pdf');
    
  } catch (error) {
    res.status(500).send('Download-Fehler: ' + error.message);
  }
});

// API: Produkte abrufen
app.get('/api/products', (req, res) => {
  res.json(products);
});

// API: Stripe Checkout Session erstellen
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { items } = req.body;
    
    const lineItems = items.map(item => ({
      price_data: {
        currency: 'eur',
        product_data: {
          name: item.name,
require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const path = require('path');
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

// WICHTIG: Reihenfolge beachten!
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// WEBHOOK zuerst (roher Body)
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
    console.log('✅ Zahlung erfolgreich:', session.customer_email);
    
    // E-Mail senden
    try {
      await resend.emails.send({
        from: process.env.FROM_EMAIL,
        to: session.customer_email,
        subject: 'Dein taghiwaves Download ist bereit!',
        html: `
          <h1>Vielen Dank für deinen Kauf!</h1>
          <p>Du hast <strong>Mixing EQ Cheat Sheet</strong> erfolgreich gekauft.</p>
          <p><a href="https://taghiwaves.onrender.com/downloads/mixing-eq-guide.pdf" 
                style="background:#00f0ff; color:#000; padding:12px 24px; text-decoration:none; border-radius:8px; display:inline-block; margin:20px 0;">
                Jetzt herunterladen
             </a></p>
          <p>Bei Fragen antworte einfach auf diese E-Mail.</p>
          <br>
          <p>taghiwaves Team</p>
        `
      });
      console.log('📧 E-Mail gesendet an:', session.customer_email);
    } catch (error) {
      console.error('❌ E-Mail Fehler:', error);
    }
  }

  res.json({received: true});
});

// ERST DANACH json parser für API Routes
app.use(express.json());

// Start Server
app.listen(PORT, () => {
  console.log(`🎵 TaghiWaves Server läuft auf Port ${PORT}`);
}); 
