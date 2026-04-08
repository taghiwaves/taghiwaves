require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const path = require('path');

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
          description: item.description,
        },
        unit_amount: item.price,
      },
      quantity: 1,
    }));

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      success_url: `${req.headers.origin}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.headers.origin}/cancel.html`,
      automatic_tax: { enabled: true },
    });

    res.json({ id: session.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Webhook für erfolgreiche Zahlungen
app.post('/api/webhook', express.raw({type: 'application/json'}), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    // Hier: E-Mail mit Download-Link senden
    console.log('Payment successful!', session);
  }

  res.json({received: true});
});

// Health Check für Render
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start Server
app.listen(PORT, () => {
  console.log(`🎵 TaghiWaves Server läuft auf Port ${PORT}`);
}); 
