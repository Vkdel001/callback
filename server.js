require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Xano configuration - Use original variable names (matching Railway setup)
const XANO_BASE_URL = process.env.XANO_BASE_URL || 'https://xbde-ekcn-8kg2.n7e.xano.io';
const XANO_CUSTOMER_API_KEY = process.env.XANO_CUSTOMER_API_KEY || 'Q4jDYUWL';
const XANO_PAYMENT_API_KEY = process.env.XANO_PAYMENT_API_KEY || '05i62DIx';
const XANO_QR_TRANSACTIONS_API_KEY = process.env.XANO_QR_TRANSACTIONS_API_KEY || '6MaKDJBx';

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

/**
 * Parse month string to Date for comparison
 * Converts "MMM-YY" format to Date object
 * Example: "Jan-25" → Date(2025, 0, 1)
 */
function parseMonthString(monthStr) {
  if (!monthStr || typeof monthStr !== 'string') return null;
  
  const parts = monthStr.split('-');
  if (parts.length !== 2) return null;
  
  const [monthName, yearStr] = parts;
  const year = parseInt('20' + yearStr); // Convert YY to YYYY
  
  const monthMap = {
    'Jan': 0, 'Feb': 1, 'Mar': 2, 'Apr': 3, 'May': 4, 'Jun': 5,
    'Jul': 6, 'Aug': 7, 'Sep': 8, 'Oct': 9, 'Nov': 10, 'Dec': 11
  };
  
  const month = monthMap[monthName];
  if (month === undefined) return null;
  
  return new Date(year, month, 1);
}

/**
 * Find the customer record with the latest assigned_month
 * Implements Latest Month Priority fallback strategy
 */
function findLatestMonthRecord(customerRecords) {
  if (!customerRecords || customerRecords.length === 0) return null;
  if (customerRecords.length === 1) return customerRecords[0];
  
  let latestRecord = null;
  let latestDate = null;
  
  for (const record of customerRecords) {
    const monthDate = parseMonthString(record.assigned_month);
    
    if (monthDate && (!latestDate || monthDate > latestDate)) {
      latestDate = monthDate;
      latestRecord = record;
    }
  }
  
  // If no valid dates found, return first record as fallback
  return latestRecord || customerRecords[0];
}

/**
 * Enhanced customer lookup with multi-month handling
 * Implements Latest Month Priority strategy for payment allocation
 */
async function findTargetCustomerRecord(originalPolicyNumber) {
  try {
    // Get all customers from Xano
    const customersResponse = await axios.get(
      `${XANO_BASE_URL}/api:${XANO_CUSTOMER_API_KEY}/nic_cc_customer`
    );
    
    // Find all records matching the policy number
    const matchingCustomers = customersResponse.data.filter(
      c => c.policy_number === originalPolicyNumber
    );
    
    if (matchingCustomers.length === 0) {
      console.error(`❌ No customer found for policy: ${originalPolicyNumber}`);
      return { success: false, error: 'Customer not found' };
    }
    
    if (matchingCustomers.length === 1) {
      console.log(`📋 Single record found for policy: ${originalPolicyNumber}`);
      return {
        success: true,
        customer: matchingCustomers[0],
        selectionReason: 'single_record',
        totalRecords: 1,
        alternativeRecords: []
      };
    }
    
    // Multiple records found - apply Latest Month Priority
    console.log(`📋 Multiple records found for policy: ${originalPolicyNumber} (${matchingCustomers.length} records)`);
    
    // Log all available records
    matchingCustomers.forEach((record, index) => {
      console.log(`   Record ${index + 1}: ID=${record.id}, Month=${record.assigned_month}, Balance=${record.amount_due}`);
    });
    
    // Select record with latest month
    const selectedCustomer = findLatestMonthRecord(matchingCustomers);
    const alternativeRecords = matchingCustomers.filter(c => c.id !== selectedCustomer.id);
    
    console.log(`✅ Selected record: ID=${selectedCustomer.id}, Month=${selectedCustomer.assigned_month} (Latest Month Priority)`);
    
    return {
      success: true,
      customer: selectedCustomer,
      selectionReason: 'latest_month_priority',
      totalRecords: matchingCustomers.length,
      alternativeRecords: alternativeRecords
    };
    
  } catch (error) {
    console.error('❌ Error in customer lookup:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Log Quick QR payment using QR transaction data
 * Used when customer doesn't exist in nic_cc_customer table
 */
async function logQuickQRPayment(qrTransaction, paymentData) {
  try {
    console.log(`📝 Logging Quick QR payment for policy: ${qrTransaction.policy_number}`);
    
    const paymentLogData = {
      // Use QR transaction data instead of customer data
      customer: null,  // No customer record exists
      policy_number: qrTransaction.policy_number,
      customer_name: qrTransaction.customer_name,
      transaction_reference: paymentData.transactionReference,
      end_to_end_reference: paymentData.endToEndReference,
      amount: parseFloat(paymentData.amount),
      mobile_number: paymentData.mobileNumber,
      payment_date: new Date().toISOString(),
      payment_status_code: paymentData.paymentStatusCode,
      status: 'success',
      old_balance: 0,  // No previous balance for Quick QR
      new_balance: 0,  // No balance tracking for Quick QR
      processed_at: new Date().toISOString(),
      
      // 🆕 Quick QR specific fields
      qr_transaction_id: qrTransaction.id,
      qr_type: qrTransaction.qr_type,
      agent_name: qrTransaction.agent_name,
      agent_email: qrTransaction.agent_email,
      customer_email: qrTransaction.customer_email,
      line_of_business: qrTransaction.line_of_business,
      selection_reason: 'quick_qr_payment',
      total_records_found: 0,
      alternative_records_count: 0
    };
    
    await axios.post(
      `${XANO_BASE_URL}/api:${XANO_PAYMENT_API_KEY}/nic_cc_payment`,
      paymentLogData
    );
    
    console.log('✅ Quick QR payment logged successfully - will trigger email notifications');
    
    return { success: true };
    
  } catch (error) {
    console.error('❌ Failed to log Quick QR payment:', error.message);
    if (error.response) {
      console.error('Payment log error details:', error.response.data);
    }
    return { success: false, error: error.message };
  }
}

/**
 * Find and update QR transaction status (if exists)
 * This is separate from email notifications - just updates the transaction status
 */
async function updateQRTransactionIfExists(policyNumber, paymentData) {
  try {
    console.log(`🔍 Checking for QR transaction for policy: ${policyNumber}`);
    
    // Get all QR transactions
    const qrResponse = await axios.get(
      `${XANO_BASE_URL}/api:${XANO_QR_TRANSACTIONS_API_KEY}/nic_qr_transactions`
    );
    
    // Find matching transactions (pending status only)
    const matchingTransactions = qrResponse.data.filter(
      t => t.policy_number === policyNumber && t.status === 'pending'
    );
    
    if (matchingTransactions.length === 0) {
      console.log(`📋 No pending QR transactions found for policy: ${policyNumber}`);
      return { success: false, message: 'No QR transaction found' };
    }
    
    // If multiple transactions, select the most recent one
    const selectedTransaction = matchingTransactions.sort(
      (a, b) => new Date(b.created_at) - new Date(a.created_at)
    )[0];
    
    console.log(`✅ Found QR transaction: ID=${selectedTransaction.id}, Type=${selectedTransaction.qr_type}, Agent=${selectedTransaction.agent_name}`);
    
    // Update QR transaction status
    const updateData = {
      status: 'paid',
      paid_at: new Date().toISOString(),
      payment_reference: paymentData.transactionReference,
      payment_amount: parseFloat(paymentData.amount),
      webhook_data: JSON.stringify(paymentData)
    };
    
    await axios.patch(
      `${XANO_BASE_URL}/api:${XANO_QR_TRANSACTIONS_API_KEY}/nic_qr_transactions/${selectedTransaction.id}`,
      updateData
    );
    
    console.log(`✅ QR transaction ${selectedTransaction.id} marked as paid`);
    
    return {
      success: true,
      transaction: selectedTransaction,
      message: 'QR transaction updated successfully'
    };
    
  } catch (error) {
    console.error('❌ Error updating QR transaction:', error.message);
    return { success: false, message: error.message };
  }
}

// Helper function to update customer balance in Xano
async function updateCustomerBalance(policyNumber, amountPaid, paymentData) {
  try {
    // 🔄 STEP 1: Reverse sanitize policy number to match database format
    const originalPolicyNumber = reverseSanitizePolicyNumber(policyNumber);
    
    console.log(`📋 Searching for customer with policy: ${originalPolicyNumber}`);
    
    // 🎯 STEP 2: Enhanced customer lookup with multi-month handling
    const lookupResult = await findTargetCustomerRecord(originalPolicyNumber);
    
    if (!lookupResult.success) {
      console.error(`❌ Customer lookup failed: ${lookupResult.error}`);
      return { success: false, error: lookupResult.error };
    }
    
    const customer = lookupResult.customer;
    
    console.log(`✅ Found customer: ${customer.name}, Current balance: ${customer.amount_due}`);
    console.log(`📊 Selection details: ${lookupResult.selectionReason} (${lookupResult.totalRecords} total records)`);
    
    // Log alternative records for audit trail
    if (lookupResult.alternativeRecords.length > 0) {
      console.log(`📝 Alternative records not selected:`);
      lookupResult.alternativeRecords.forEach((alt, index) => {
        console.log(`   Alt ${index + 1}: ID=${alt.id}, Month=${alt.assigned_month}, Balance=${alt.amount_due}`);
      });
    }
    
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
    
    // 5. Log payment in Xano with enhanced audit trail
    try {
      const paymentLogData = {
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
        processed_at: new Date().toISOString(),
        
        // 🆕 Enhanced audit fields for multi-month tracking
        assigned_month: customer.assigned_month,
        selection_reason: lookupResult.selectionReason,
        total_records_found: lookupResult.totalRecords,
        alternative_records_count: lookupResult.alternativeRecords.length
      };
      
      await axios.post(
        `${XANO_BASE_URL}/api:${XANO_PAYMENT_API_KEY}/nic_cc_payment`,
        paymentLogData
      );
      console.log('✅ Payment logged successfully with audit trail');
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
      fullyPaid: newBalance === 0,
      
      // 🆕 Enhanced response with multi-month details
      assignedMonth: customer.assigned_month,
      selectionReason: lookupResult.selectionReason,
      totalRecords: lookupResult.totalRecords,
      customerId: customer.id
    };
    
  } catch (error) {
    console.error('❌ Failed to update customer balance:', error.message);
    if (error.response) {
      console.error('Error response:', error.response.data);
    }
    return { success: false, error: error.message };
  }
}

// Main callback endpoint - Simple approach like original webhook
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
      
      // 🔄 STEP 1: Reverse sanitize policy number
      const originalPolicyNumber = reverseSanitizePolicyNumber(billNumber);
      
      // 🎯 STEP 2: Update QR transaction status (if exists) - NO EMAIL SENDING
      const qrResult = await updateQRTransactionIfExists(originalPolicyNumber, {
        transactionReference,
        endToEndReference,
        amount,
        mobileNumber,
        paymentStatusCode,
        customerLabel
      });
      
      // 🎯 STEP 3: Update customer balance (existing functionality)
      const updateResult = await updateCustomerBalance(billNumber, amount, {
        transactionReference,
        endToEndReference,
        mobileNumber,
        paymentStatusCode,
        customerLabel
      });
      
      if (updateResult.success) {
        console.log(`✅ Payment processed successfully for ${updateResult.customer}`);
        console.log(`   Customer ID: ${updateResult.customerId}`);
        console.log(`   Assigned Month: ${updateResult.assignedMonth}`);
        console.log(`   Selection Method: ${updateResult.selectionReason}`);
        console.log(`   Total Records: ${updateResult.totalRecords}`);
        console.log(`   Old balance: MUR ${updateResult.oldBalance}`);
        console.log(`   Amount paid: MUR ${updateResult.amountPaid}`);
        console.log(`   New balance: MUR ${updateResult.newBalance}`);
        console.log(`   Status: ${updateResult.fullyPaid ? 'FULLY PAID' : 'PARTIAL PAYMENT'}`);
        
        // 🆕 Log QR transaction processing results (if any)
        if (qrResult.success) {
          console.log(`   QR Transaction: ✅ Updated (ID: ${qrResult.transaction.id})`);
          console.log(`   QR Type: ${qrResult.transaction.qr_type}`);
          console.log(`   Agent: ${qrResult.transaction.agent_name}`);
          console.log(`   📧 Email notifications will be handled by payment notification service`);
        } else {
          console.log(`   QR Transaction: ℹ️ None found (regular payment)`);
        }
        
      } else {
        console.error(`❌ Failed to process payment: ${updateResult.error}`);
        
        // 🆕 FALLBACK: Handle Quick QR payments where customer doesn't exist in nic_cc_customer
        if (qrResult.success && updateResult.error === 'Customer not found') {
          console.log(`🔄 Quick QR Payment Detected - Customer not in nic_cc_customer table`);
          console.log(`   Processing as Quick QR payment using transaction data...`);
          
          // Log payment using QR transaction data for email notifications
          const qrPaymentResult = await logQuickQRPayment(qrResult.transaction, {
            transactionReference,
            endToEndReference,
            amount,
            mobileNumber,
            paymentStatusCode,
            customerLabel
          });
          
          if (qrPaymentResult.success) {
            console.log(`✅ Quick QR payment logged successfully`);
            console.log(`   QR Transaction: ✅ Updated (ID: ${qrResult.transaction.id})`);
            console.log(`   QR Type: ${qrResult.transaction.qr_type}`);
            console.log(`   Customer: ${qrResult.transaction.customer_name}`);
            console.log(`   Agent: ${qrResult.transaction.agent_name}`);
            console.log(`   📧 Email notifications will be handled by payment notification service`);
          } else {
            console.error(`❌ Failed to log Quick QR payment: ${qrPaymentResult.error}`);
          }
        }
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
  console.log(`Enhanced Payment Callback Server running on port ${PORT}`);
  console.log(`Callback endpoint: http://localhost:${PORT}/api/payment/v1/response-callback`);
  console.log('🆕 Features enabled:');
  console.log('   ✅ QR Transaction Status Updates');
  console.log('   ✅ Multi-Month Policy Handling');
  console.log('   ✅ Enhanced Audit Trail');
  console.log('   📧 Email notifications handled by separate payment notification service');
  console.log('\n🔧 Configuration:');
  console.log(`   XANO_BASE_URL: ${XANO_BASE_URL}`);
  console.log(`   QR_TRANSACTIONS_API: ${XANO_QR_TRANSACTIONS_API_KEY}`);
});