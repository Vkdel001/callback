@echo off
echo Testing Payment Callback API with curl...
echo.

echo 1. Testing health check:
curl -X GET http://localhost:3000/health
echo.
echo.

echo 2. Testing callback endpoint:
curl -X POST http://localhost:3000/api/payment/v1/response-callback ^
  -H "Content-Type: application/json" ^
  -d "{\"paymentStatusCode\":\"ACSP\",\"endToEndReference\":\"MCBLMUMU20251007443885O\",\"amount\":\"1.20\",\"transactionReference\":23666,\"billNumber\":\"0000001190\",\"mobileNumber\":\"55078912\",\"storeLabel\":\"\",\"loyaltyNumber\":\"\",\"referenceLabel\":\"ZPMQR0000025085\",\"customerLabel\":\"\",\"terminalLabel\":\"\",\"purposeOfTransaction\":\"\"}"
echo.
echo.

echo 3. Testing with different status code:
curl -X POST http://localhost:3000/api/payment/v1/response-callback ^
  -H "Content-Type: application/json" ^
  -d "{\"paymentStatusCode\":\"RJCT\",\"endToEndReference\":\"MCBLMUMU20251007443886O\",\"amount\":\"5.50\",\"transactionReference\":23667,\"billNumber\":\"0000001191\",\"mobileNumber\":\"55078913\",\"referenceLabel\":\"ZPMQR0000025086\"}"
echo.
echo.

echo Done!