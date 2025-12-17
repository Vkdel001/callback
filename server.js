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
const XANO_QR_TRANSACTIONS_API_KEY = process.env.XANO_QR_TRANSACTIONS_API_KEY || '6MaKDJBx';

// Email configuration (Brevo)
const BREVO_API_KEY = process.env.BREVO_API_KEY || process.env.VITE_BREVO_API_KEY;
const SENDER_EMAIL = process.env.SENDER_EMAIL || process.env.VITE_SENDER_EMAIL || 'arrears@niclmauritius.site';
const SENDER_NAME = process.env.SENDER_NAME || process.env.VITE_SENDER_NAME || 'NIC Life Insurance Mauritius';

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
 * 🆕 Find QR transaction by policy number or QR data
 * Searches the nic_qr_transactions table for matching records
 */
async function findQRTransaction(policyNumber, qrData = null) {
  try {
    console.log(`🔍 Searching QR transactions for policy: ${policyNumber}`);
    
    // Get all QR transactions
    const qrResponse = await axios.get(
      `${XANO_BASE_URL}/api:${XANO_QR_TRANSACTIONS_API_KEY}/nic_qr_transactions`
    );
    
    // Find matching transactions (pending status only)
    let matchingTransactions = qrResponse.data.filter(
      t => t.policy_number === policyNumber && t.status === 'pending'
    );
    
    // If QR data provided, try to match by QR data as well
    if (qrData && matchingTransactions.length === 0) {
      matchingTransactions = qrResponse.data.filter(
        t => t.qr_data === qrData && t.status === 'pending'
      );
    }
    
    if (matchingTransactions.length === 0) {
      console.log(`📋 No pending QR transactions found for policy: ${policyNumber}`);
      return { success: false, error: 'No QR transaction found' };
    }
    
    // If multiple transactions, select the most recent one
    const selectedTransaction = matchingTransactions.sort(
      (a, b) => new Date(b.created_at) - new Date(a.created_at)
    )[0];
    
    console.log(`✅ Found QR transaction: ID=${selectedTransaction.id}, Type=${selectedTransaction.qr_type}, Agent=${selectedTransaction.agent_name}`);
    
    return {
      success: true,
      transaction: selectedTransaction,
      totalFound: matchingTransactions.length
    };
    
  } catch (error) {
    console.error('❌ Error finding QR transaction:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * 🆕 Update QR transaction status to paid
 */
async function updateQRTransactionStatus(transactionId, paymentData) {
  try {
    const updateData = {
      status: 'paid',
      paid_at: new Date().toISOString(),
      payment_reference: paymentData.transactionReference,
      payment_amount: parseFloat(paymentData.amount),
      webhook_data: JSON.stringify(paymentData)
    };
    
    await axios.patch(
      `${XANO_BASE_URL}/api:${XANO_QR_TRANSACTIONS_API_KEY}/nic_qr_transactions/${transactionId}`,
      updateData
    );
    
    console.log(`✅ QR transaction ${transactionId} marked as paid`);
    return { success: true };
    
  } catch (error) {
    console.error(`❌ Failed to update QR transaction ${transactionId}:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * 🆕 Send payment confirmation email to customer
 */
async function sendCustomerPaymentConfirmation(transaction, paymentData) {
  try {
    if (!transaction.customer_email || !BREVO_API_KEY) {
      console.log('⚠️ Skipping customer notification - missing email or API key');
      return { success: false, error: 'Missing email or API key' };
    }
    
    const emailData = {
      sender: {
        name: SENDER_NAME,
        email: SENDER_EMAIL
      },
      to: [
        {
          email: transaction.customer_email,
          name: transaction.customer_name || 'Customer'
        }
      ],
      subject: `Payment Confirmation - Policy ${transaction.policy_number}`,
      htmlContent: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #16a34a 0%, #15803d 100%); color: white; padding: 20px; text-align: center;">
            <h1 style="margin: 0; font-size: 24px;">✅ Payment Confirmed!</h1>
            <p style="margin: 10px 0 0 0; opacity: 0.9;">Your payment has been successfully processed</p>
          </div>
          
          <div style="padding: 30px; background: #f8f9fa;">
            <div style="background: white; padding: 25px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
              <h2 style="color: #333; margin-top: 0;">Payment Confirmation</h2>
              
              <div style="background: #e8f5e8; padding: 15px; border-radius: 6px; margin: 20px 0;">
                <p style="margin: 0; color: #2d5a2d; font-weight: bold;">✅ Payment Status: SUCCESSFUL</p>
              </div>
              
              <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
                <tr>
                  <td style="padding: 8px 0; border-bottom: 1px solid #eee; font-weight: bold; color: #555;">Policy Number:</td>
                  <td style="padding: 8px 0; border-bottom: 1px solid #eee; color: #333;">${transaction.policy_number}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; border-bottom: 1px solid #eee; font-weight: bold; color: #555;">Customer Name:</td>
                  <td style="padding: 8px 0; border-bottom: 1px solid #eee; color: #333;">${transaction.customer_name}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; border-bottom: 1px solid #eee; font-weight: bold; color: #555;">Amount Paid:</td>
                  <td style="padding: 8px 0; border-bottom: 1px solid #eee; color: #333; font-weight: bold;">MUR ${parseFloat(paymentData.amount).toFixed(2)}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; border-bottom: 1px solid #eee; font-weight: bold; color: #555;">Line of Business:</td>
                  <td style="padding: 8px 0; border-bottom: 1px solid #eee; color: #333;">${transaction.line_of_business}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; border-bottom: 1px solid #eee; font-weight: bold; color: #555;">Transaction Reference:</td>
                  <td style="padding: 8px 0; border-bottom: 1px solid #eee; color: #333; font-family: monospace;">${paymentData.transactionReference}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; font-weight: bold; color: #555;">Payment Date:</td>
                  <td style="padding: 8px 0; color: #333;">${new Date().toLocaleString()}</td>
                </tr>
              </table>
              
              <div style="background: #f0f7ff; padding: 15px; border-radius: 6px; margin: 20px 0;">
                <p style="margin: 0; color: #1a5490; font-size: 14px;">
                  <strong>Thank you!</strong> Your payment has been processed and your account has been updated. 
                  You will receive an updated statement within 1-2 business days.
                </p>
              </div>
              
              ${transaction.agent_email ? `
              <div style="background: #f9fafb; padding: 15px; border-radius: 6px; border: 1px solid #e5e7eb; margin: 20px 0;">
                <h4 style="margin-top: 0; color: #333;">Your Agent Contact</h4>
                <p style="margin: 5px 0;"><strong>Name:</strong> ${transaction.agent_name || 'Your Agent'}</p>
                <p style="margin: 5px 0;"><strong>Email:</strong> ${transaction.agent_email}</p>
                <p style="margin: 10px 0 0 0; font-size: 14px; color: #666;">For any questions about your policy, please contact your agent.</p>
              </div>
              ` : ''}
            </div>
          </div>
          
          <div style="background: #333; color: white; padding: 20px; text-align: center; font-size: 12px;">
            <p style="margin: 0; opacity: 0.8;">NIC Life Insurance Mauritius - Payment Confirmation</p>
            <p style="margin: 5px 0 0 0; opacity: 0.6;">This is an automated message. Please keep this email for your records.</p>
          </div>
        </div>
      `
    };
    
    const response = await axios.post(
      'https://api.brevo.com/v3/smtp/email',
      emailData,
      {
        headers: {
          'api-key': BREVO_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );
    
    console.log(`✅ Customer confirmation sent to ${transaction.customer_email}`);
    return { success: true, messageId: response.data.messageId };
    
  } catch (error) {
    console.error('❌ Failed to send customer confirmation:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * 🆕 Send payment confirmation email to agent
 */
async function sendAgentPaymentNotification(transaction, paymentData) {
  try {
    if (!transaction.agent_email || !BREVO_API_KEY) {
      console.log('⚠️ Skipping agent notification - missing email or API key');
      return { success: false, error: 'Missing email or API key' };
    }
    
    const emailData = {
      sender: {
        name: SENDER_NAME,
        email: SENDER_EMAIL
      },
      to: [
        {
          email: transaction.agent_email,
          name: transaction.agent_name || 'Agent'
        }
      ],
      subject: `Payment Received - QR Code Success`,
      htmlContent: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; text-align: center;">
            <h1 style="margin: 0; font-size: 24px;">🎉 Payment Received!</h1>
            <p style="margin: 10px 0 0 0; opacity: 0.9;">Your QR code has been successfully paid</p>
          </div>
          
          <div style="padding: 30px; background: #f8f9fa;">
            <div style="background: white; padding: 25px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
              <h2 style="color: #333; margin-top: 0;">Payment Details</h2>
              
              <div style="background: #e8f5e8; padding: 15px; border-radius: 6px; margin: 20px 0;">
                <p style="margin: 0; color: #2d5a2d; font-weight: bold;">✅ Payment Status: SUCCESSFUL</p>
              </div>
              
              <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
                <tr>
                  <td style="padding: 8px 0; border-bottom: 1px solid #eee; font-weight: bold; color: #555;">Policy Number:</td>
                  <td style="padding: 8px 0; border-bottom: 1px solid #eee; color: #333;">${transaction.policy_number}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; border-bottom: 1px solid #eee; font-weight: bold; color: #555;">Customer Name:</td>
                  <td style="padding: 8px 0; border-bottom: 1px solid #eee; color: #333;">${transaction.customer_name}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; border-bottom: 1px solid #eee; font-weight: bold; color: #555;">Amount Paid:</td>
                  <td style="padding: 8px 0; border-bottom: 1px solid #eee; color: #333; font-weight: bold;">MUR ${parseFloat(paymentData.amount).toFixed(2)}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; border-bottom: 1px solid #eee; font-weight: bold; color: #555;">Line of Business:</td>
                  <td style="padding: 8px 0; border-bottom: 1px solid #eee; color: #333;">${transaction.line_of_business}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; border-bottom: 1px solid #eee; font-weight: bold; color: #555;">QR Type:</td>
                  <td style="padding: 8px 0; border-bottom: 1px solid #eee; color: #333;">${transaction.qr_type === 'quick_qr' ? 'Quick QR' : 'Customer Detail QR'}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; border-bottom: 1px solid #eee; font-weight: bold; color: #555;">Transaction Reference:</td>
                  <td style="padding: 8px 0; border-bottom: 1px solid #eee; color: #333; font-family: monospace;">${paymentData.transactionReference}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; font-weight: bold; color: #555;">Payment Date:</td>
                  <td style="padding: 8px 0; color: #333;">${new Date().toLocaleString()}</td>
                </tr>
              </table>
              
              <div style="background: #f0f7ff; padding: 15px; border-radius: 6px; margin: 20px 0;">
                <p style="margin: 0; color: #1a5490; font-size: 14px;">
                  <strong>Great work!</strong> This payment will be reflected in your QR performance dashboard and contribute to your conversion metrics.
                </p>
              </div>
            </div>
          </div>
          
          <div style="background: #333; color: white; padding: 20px; text-align: center; font-size: 12px;">
            <p style="margin: 0; opacity: 0.8;">NIC Life Insurance Mauritius - Automated Payment Notification</p>
            <p style="margin: 5px 0 0 0; opacity: 0.6;">This is an automated message. Please do not reply to this email.</p>
          </div>
        </div>
      `
    };
    
    const response = await axios.post(
      'https://api.brevo.com/v3/smtp/email',
      emailData,
      {
        headers: {
          'api-key': BREVO_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );
    
    console.log(`✅ Agent notification sent to ${transaction.agent_email}`);
    return { success: true, messageId: response.data.messageId };
    
  } catch (error) {
    console.error('❌ Failed to send agent notification:', error.message);
    return { success: false, error: error.message };
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

// 🆕 Enhanced main callback endpoint with QR transaction integration
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
      
      // 🎯 STEP 2: Check for QR transaction first (new feature)
      console.log('🔍 Checking for QR transaction...');
      const qrResult = await findQRTransaction(originalPolicyNumber);
      
      let qrTransactionProcessed = false;
      let agentNotificationSent = false;
      
      if (qrResult.success) {
        console.log('📱 QR transaction found - processing QR payment...');
        
        // Update QR transaction status
        const qrUpdateResult = await updateQRTransactionStatus(qrResult.transaction.id, {
          transactionReference,
          endToEndReference,
          amount,
          mobileNumber,
          paymentStatusCode,
          customerLabel
        });
        
        if (qrUpdateResult.success) {
          qrTransactionProcessed = true;
          console.log('✅ QR transaction updated successfully');
          
          // Send notification to customer
          const customerNotificationResult = await sendCustomerPaymentConfirmation(qrResult.transaction, {
            transactionReference,
            amount,
            endToEndReference
          });
          
          if (customerNotificationResult.success) {
            console.log('✅ Customer confirmation sent successfully');
          } else {
            console.log('⚠️ Customer confirmation failed:', customerNotificationResult.error);
          }
          
          // Send notification to agent
          const agentNotificationResult = await sendAgentPaymentNotification(qrResult.transaction, {
            transactionReference,
            amount,
            endToEndReference
          });
          
          if (agentNotificationResult.success) {
            agentNotificationSent = true;
            console.log('✅ Agent notification sent successfully');
          } else {
            console.log('⚠️ Agent notification failed:', agentNotificationResult.error);
          }
        } else {
          console.log('⚠️ QR transaction update failed:', qrUpdateResult.error);
        }
      } else {
        console.log('📋 No QR transaction found - this is a regular payment');
      }
      
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
        
        // 🆕 Log QR transaction processing results
        if (qrTransactionProcessed) {
          console.log(`   QR Transaction: ✅ Updated (ID: ${qrResult.transaction.id})`);
          console.log(`   QR Type: ${qrResult.transaction.qr_type}`);
          console.log(`   Customer: ${qrResult.transaction.customer_name} (${qrResult.transaction.customer_email})`);
          console.log(`   Agent: ${qrResult.transaction.agent_name} (${qrResult.transaction.agent_email})`);
          console.log(`   Customer Confirmation: ${qrResult.transaction.customer_email ? '✅ Sent' : '❌ No Email'}`);
          console.log(`   Agent Notification: ${agentNotificationSent ? '✅ Sent' : '❌ Failed'}`);
        } else {
          console.log(`   QR Transaction: ℹ️ None found (regular payment)`);
        }
        
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
  console.log(`Enhanced Payment Callback Server running on port ${PORT}`);
  console.log(`Callback endpoint: http://localhost:${PORT}/api/payment/v1/response-callback`);
  console.log('🆕 Features enabled:');
  console.log('   ✅ QR Transaction Integration');
  console.log('   ✅ Agent Payment Notifications');
  console.log('   ✅ Multi-Month Policy Handling');
  console.log('   ✅ Enhanced Audit Trail');
});