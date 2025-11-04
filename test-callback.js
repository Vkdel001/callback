const axios = require('axios');

const testPayload = {
  "paymentStatusCode": "ACSP",
  "endToEndReference": "MCBLMUMU20251007443885O",
  "amount": "1.20",
  "transactionReference": 23666,
  "billNumber": "0000001190",
  "mobileNumber": "55078912",
  "storeLabel": "",
  "loyaltyNumber": "",
  "referenceLabel": "ZPMQR0000025085",
  "customerLabel": "",
  "terminalLabel": "",
  "purposeOfTransaction": ""
};

async function testCallback() {
  try {
    console.log('Testing callback endpoint...');
    console.log('Sending payload:', JSON.stringify(testPayload, null, 2));
    
    const response = await axios.post('http://localhost:3000/api/payment/v1/response-callback', testPayload, {
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    console.log('\n✅ Success!');
    console.log('Status:', response.status);
    console.log('Response:', response.data);
    
  } catch (error) {
    console.log('\n❌ Error!');
    if (error.response) {
      console.log('Status:', error.response.status);
      console.log('Response:', error.response.data);
    } else {
      console.log('Error:', error.message);
    }
  }
}

async function testHealthCheck() {
  try {
    console.log('\nTesting health check...');
    const response = await axios.get('http://localhost:3000/health');
    console.log('✅ Health check passed:', response.data);
  } catch (error) {
    console.log('❌ Health check failed:', error.message);
  }
}

// Run tests
async function runTests() {
  await testHealthCheck();
  await testCallback();
}

runTests();