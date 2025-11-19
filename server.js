require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Xano configuration
const XANO_BASE_URL = process.env.XANO_BASE_URL || 'https://xbde-ekcn-8kg2.n7e.xano.io';
const XANO_CUSTOMER_API_KEY = process.env.XANO_CUSTOMER_API_KEY || 'Q4jDYUWL';
const XANO_PAYMENT_API_KEY = process.env.XANO_PAYMENT_API_KEY || '05i62DIx';

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

/**
 * Reverse sanitize policy number
 * Converts dots back to slashes to match database format
 * Example: "HEALTH.2024.001" → "HEALTH/2024/001"
 */
function reverseSanitizePolicyNumber(sanitizedPolicy) {
  if (!sanitizedPolicy) return sanitizedPolicy;
  
  // Replace all dots with slashes (reverse of QR sanitization)
  const original = sanitizedPolicy.replace(/\./g, '/');
  
  console.log(`🔄 Policy number reverse-sanitized: "${sanitizedPolicy}" → "${original}"`);
  
  return original;
}

// Helper function to update customer balance in Xano
async function updateCustomerBalance(policyNumber, amountPaid, paymentData) {
  try {
    // 🔄 STEP 1: Reverse sanitize policy number to match database format
    const originalPolicyNumber = reverseSanitizePolicyNumber(policyNumber);
    
    console.log(`📋 Searching for customer with policy: ${originalPolicyNumber}`);
    
    // 2. Get customer by policy number (using original format)
    const customersResponse = await axios.get(
      `${XANO_BASE_URL}/api:${XANO_CUSTOMER_API_KEY}/nic_cc_customer`
    );
    
    const customer = customersResponse.data.find(
      c => c.policy_number === originalPolicyNumber
    );
    
    if (!customer) {
      console.error(`❌ Customer not found for policy: ${originalPolicyNumber} (sanitized: ${policyNumber})`);
      return { success: false, error: 'Customer not found' };
    }
    
    console.log(`Found customer: ${customer.name}, Current balance: ${customer.amount_due}`);
    
    // 2. Calculate new balance
    const currentBalance = parseFloat(customer.amount_due) || 0;
    const paid = parseFloat(amountPaid);
    const newBalance = Math.max(0, currentBalance - paid);
    
    console.log(`Updating balance: ${currentBalance} - ${paid} = ${newBalance}`);
    
    // 3. Determine new status (only change if fully paid)
    let newStatus = customer.status;
    if (newBalance === 0) {
      newStatus = 'resolved';
    }
    
    // 4. Update customer in Xano
    await axios.patch(
      `${XANO_BASE_URL}/api:${XANO_CUSTOMER_API_KEY}/nic_cc_customer/${customer.id}`,
      {
        amount_due: newBalance,
        status: newStatus,
        last_call_date: new Date().toISOString().split('T')[0]
      }
    );
    
    console.log(`✅ Customer updated successfully. New balance: ${newBalance}`);
    
    // 5. Log payment in Xano
    try {
      await axios.post(
        `${XANO_BASE_URL}/api:${XANO_PAYMENT_API_KEY}/nic_cc_payment`,
        {
          customer: customer.id,  // ⭐ CORRECT: Use 'customer' not 'customer_id'
          policy_number: originalPolicyNumber,  // ✅ Use original format for database
          customer_name: customer.name,
          transaction_reference: paymentData.transactionReference,
          end_to_end_reference: paymentData.endToEndReference,
          amount: paid,
          mobile_number: paymentData.mobileNumber,
          payment_date: new Date().toISOString(),
          payment_status_code: paymentData.paymentStatusCode,
          status: 'success',
          old_balance: currentBalance,
          new_balance: newBalance,
          processed_at: new Date().toISOString()
        }
      );
      console.log('✅ Payment logged successfully');
    } catch (paymentLogError) {
      console.error('⚠️ Failed to log payment:', paymentLogError.message);
      console.error('Payment log error details:', paymentLogError.response?.data);
    }
    
    return {
      success: true,
      customer: customer.name,
      customerEmail: customer.email,
      oldBalance: currentBalance,
      newBalance: newBalance,
      amountPaid: paid,
      fullyPaid: newBalance === 0
    };
    
  } catch (error) {
    console.error('❌ Failed to update customer balance:', error.message);
    if (error.response) {
      console.error('Error response:', error.response.data);
    }
    return { success: false, error: error.message };
  }
}

// Main callback endpoint
app.post('/api/payment/v1/response-callback', async (req, res) => {
  try {
    const {
      paymentStatusCode,
      endToEndReference,
      amount,
      transactionReference,
      billNumber,
      mobileNumber,
      customerLabel
    } = req.body;

    console.log('Payment callback received:', {
      paymentStatusCode,
      endToEndReference,
      amount,
      transactionReference,
      billNumber,
      mobileNumber,
      customerLabel,
      timestamp: new Date().toISOString()
    });

    // Validate required fields
    if (!paymentStatusCode || !transactionReference) {
      return res.status(400).json({
        error: 'Missing required fields: paymentStatusCode and transactionReference'
      });
    }

    // Only process successful payments
    if (paymentStatusCode === 'ACSP') {
      console.log('✅ Payment successful, processing...');
      
      if (!billNumber) {
        console.error('❌ No policy number in callback');
        return res.json({
          message: "Callback received but no policy number provided"
        });
      }
      
      // Update customer balance in Xano
      const updateResult = await updateCustomerBalance(billNumber, amount, {
        transactionReference,
        endToEndReference,
        mobileNumber,
        paymentStatusCode,
        customerLabel
      });
      
      if (updateResult.success) {
        console.log(`✅ Payment processed successfully for ${updateResult.customer}`);
        console.log(`   Old balance: MUR ${updateResult.oldBalance}`);
        console.log(`   Amount paid: MUR ${updateResult.amountPaid}`);
        console.log(`   New balance: MUR ${updateResult.newBalance}`);
        console.log(`   Status: ${updateResult.fullyPaid ? 'FULLY PAID' : 'PARTIAL PAYMENT'}`);
      } else {
        console.error(`❌ Failed to process payment: ${updateResult.error}`);
      }
    } else {
      console.log(`⚠️ Payment not successful. Status: ${paymentStatusCode}`);
    }

    // Always return success to payment gateway
    res.json({
      message: "Callback received successfully"
    });
    
  } catch (error) {
    console.error('Error processing callback:', error);
    res.status(200).json({
      message: "Callback received but processing failed",
      error: error.message
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
