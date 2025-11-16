import https from 'https';
import dotenv from 'dotenv';
import StorePayment from '../models/Storepayment.js';
import Order from '../models/Order.js';

dotenv.config();

export const initializeTransaction = async ({ email, amount, Id, modelType }) => {
  if (!['store', 'order'].includes(modelType)) {
    throw new Error("Invalid modelType. Must be 'store' or 'order'");
  }

  if (!Id) {
    throw new Error("Id is required to initialize the transaction");
  }

  const params = JSON.stringify({
    email,
    amount: amount * 100, // Convert to kobo
  });

  const options = {
    hostname: 'api.paystack.co',
    path: '/transaction/initialize',
    method: 'POST',
    headers: {
      Authorization: 'Bearer sk_test_03aea983bf7bed30fabea4dde6a1f3cf3db1b0be',
      'Content-Type': 'application/json',
    },
  };

  try {
    const paymentData = await new Promise((resolve, reject) => {
      const paystackRequest = https.request(options, (paystackResponse) => {
        let data = '';
        paystackResponse.on('data', (chunk) => {
          data += chunk;
        });
        paystackResponse.on('end', () => {
          try {
            const parsedData = JSON.parse(data);
            resolve(parsedData);
          } catch (parseError) {
            reject(new Error("Error parsing Paystack response"));
          }
        });
      });

      paystackRequest.on('error', (error) => {
        console.error('Paystack Request Error:', error);
        reject(error);
      });
      paystackRequest.write(params);
      paystackRequest.end();
    });

    if (!paymentData.status) {
      throw new Error(paymentData.message || "Failed to initialize Paystack payment");
    }

    // Save the Paystack reference to the appropriate model
    if (modelType === 'store') {
      await StorePayment.findByIdAndUpdate(Id, {
        reference: paymentData.data.reference,
        status: 'pending',
      });
    } else if (modelType === 'order') {
      await Order.findByIdAndUpdate(Id, {
        reference: paymentData.data.reference,
        status: 'paymentPending',
      });
    }

    return {
      paymentUrl: paymentData.data.authorization_url,
      reference: paymentData.data.reference,
      paymentStatus:paymentData.status
    };
  } catch (error) {
    console.error('Transaction Initialization Error:', error); // Log full error for debugging
    throw new Error("Server error: " + error.message);
  }
};

 export const createTransferRecipient = async (name, accountNumber, bankCode) => {
  const params = JSON.stringify({
    type: "nuban",
    name,
    account_number: accountNumber,
    bank_code: bankCode,
    currency: "NGN"
  });

  const options = {
    hostname: 'api.paystack.co',
    path: '/transferrecipient',
    method: 'POST',
    headers: {
      Authorization: 'Bearer sk_test_03aea983bf7bed30fabea4dde6a1f3cf3db1b0be',
      'Content-Type': 'application/json',
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        const result = JSON.parse(data);
        console.log(`this is ${JSON.stringify(result, null, 2)}`);
        if (result.status) {
          resolve(result.data.recipient_code); // Return recipient code
        } else {
          reject(result.message || "Failed to create recipient");
        }
      });
    });

    req.on('error', reject);
    req.write(params);
    req.end();
  });
};


export const transferToStoreOwner = async ( email,amount, recipientCode,name) => {
    const params = JSON.stringify({ amount: amount * 100, recipient: recipientCode });
    const options = {
        hostname: 'api.paystack.co',
        path: '/transfer',
        method: 'POST',
        headers: {
            Authorization: 'Bearer sk_test_03aea983bf7bed30fabea4dde6a1f3cf3db1b0be',
            'Content-Type': 'application/json',
        },
    };

    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                const result = JSON.parse(data);
                if (result.status === 'success') {
                    // Notify store owner via email after successful transfer
                    sentPaymentNotification(email, amount,name);
                    resolve(result);
                } else {
                    reject('Payment transfer failed');
                }
            });
        });

        req.on('error', reject);
        req.write(params);
        req.end();
    });
};

export const verifyStorePayment = async (transferReference) => {
    const options = {
        hostname: 'api.paystack.co',
        path: `/transfer/${transferReference}`,
        method: 'GET',
        headers: {
            Authorization: 'Bearer sk_test_03aea983bf7bed30fabea4dde6a1f3cf3db1b0be',
        },
    };

    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', () => resolve(JSON.parse(data)));
        });

        req.on('error', reject);
        req.end();
    });
};

