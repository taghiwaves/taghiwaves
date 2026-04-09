require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const path = require('path');
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

// WICHTIG: Webhook muss VOR express.json() kommen!
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Produkte (in Produktion: Datenbank)
const products = [
  {
    id: "prod_cheat",
    name: "Mixing EQ Cheat Sheet",
    price: 50, // 0,50€ in cents
    description: "Schnellreferenz für EQ-Einstellungen aller Instrumente. PDF-Download."
  }
];

// WEBHOOK zuerst (roher Body, kein express.json() davor!)
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
    
    // Email aus verschiedenen möglichen Quellen extrahieren
    const email = session.customer_details?.email || session.customer_email;
    
    console.log('✅ Zahlung erfolgreich:', email);
    
    if (!email) {
      console.error('❌ Keine E-Mail im Session Object gefunden');
      return res.json({received: true});
    }

    // E-Mail senden
    try {
      await resend.emails.send({
        from: process.env.FROM_EMAIL,
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

// ERST DANACH json parser für API Routes
app.use(express.json());

// Sichere Download-Route - KORRIGIERT für success.html
app.get('/api/download/mixing-eq-guide', async (req, res) => {
  const sessionId = req.query.session_id;
  
  if (!sessionId) {
    return res.status(403).send('Zugriff verweigert. Bitte erst kaufen.');
  }
  
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    
    if (session.payment_status !== 'paid') {
      return res.status(403).send('Zahlung nicht bestätigt.');
    }
    
    const filePath = path.join(__dirname, 'public', 'downloads', 'mixing-eq-guide.pdf');
    res.download(filePath, 'Mixing-EQ-Cheat-Sheet.pdf');
    
  } catch (error) {
    console.error('Download-Fehler:', error);
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
    const { items, customerEmail } = req.body;
    
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

    // Wenn E-Mail vom Frontend kommt, nutze sie
    if (customerEmail) {
      sessionConfig.customer_email = customerEmail;
    } else {
      // Sonst lässt Stripe den Kunden nach E-Mail fragen
      sessionConfig.customer_creation = 'always';
    }

    const session = await stripe.checkout.sessions.create(sessionConfig);

    res.json({ id: session.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Health Check für Render
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start Server
app.listen(PORT, () => {
  console.log(`🎵 taghiwaves Server läuft auf Port ${PORT}`);
});