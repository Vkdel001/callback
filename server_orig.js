const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  console.log('Headers:', req.headers);
  if (req.body && Object.keys(req.body).length > 0) {
    console.log('Body:', JSON.stringify(req.body, null, 2));
  }
  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Main callback endpoint matching your documentation
app.post('/api/payment/v1/response-callback', (req, res) => {
  try {
    const {
      paymentStatusCode,
      endToEndReference,
      amount,
      transactionReference,
      billNumber,
      mobileNumber,
      storeLabel,
      loyaltyNumber,
      referenceLabel,
      customerLabel,
      terminalLabel,
      purposeOfTransaction
    } = req.body;

    // Log the received payment data
    console.log('Payment callback received:', {
      paymentStatusCode,
      endToEndReference,
      amount,
      transactionReference,
      billNumber,
      mobileNumber,
      referenceLabel,
      timestamp: new Date().toISOString()
    });

    // Validate required fields
    if (!paymentStatusCode || !transactionReference) {
      return res.status(400).json({
        error: 'Missing required fields: paymentStatusCode and transactionReference'
      });
    }

    // Process the payment callback (add your business logic here)
    // For now, just log and acknowledge receipt
    
    // Return success response in the expected format
    res.json({
      message: "Callback received successfully"
    });

  } catch (error) {
    console.error('Error processing callback:', error);
    res.status(500).json({
      error: 'Internal server error'
    });
  }
});

// Catch-all for undefined routes
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Endpoint not found'
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({
    error: 'Internal server error'
  });
});

app.listen(PORT, () => {
  console.log(`Payment callback server running on port ${PORT}`);
  console.log(`Callback endpoint: http://localhost:${PORT}/api/payment/v1/response-callback`);
});