# Payment Callback API

A simple Express.js server to handle payment callback notifications.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Start the server:
```bash
npm start
```

For development with auto-reload:
```bash
npm run dev
```

## API Endpoint

**POST** `/api/payment/v1/response-callback`

### Request Payload Example:
```json
{
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
}
```

### Response:
```json
{
  "message": "Callback received successfully"
}
```

## Health Check

**GET** `/health` - Returns server status

## Environment Variables

- `PORT` - Server port (default: 3000)

## Hosting Options

See hosting recommendations in the documentation.