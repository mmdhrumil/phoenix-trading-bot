import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  sendAndConfirmTransaction,
  TransactionInstruction
} from "@solana/web3.js";
import * as phoenixSdk from "@ellipsis-labs/phoenix-sdk";

require('dotenv').config(); 

export const execute = async() => {
   
    const REFRESH_FREQUENCY_IN_MS = 2_000;
    const MAX_ITERATIONS = 3;
    
    // Edge of $0.5
    const EDGE = 0.5;
  
    // Maximum time an order is valid for 
    const ORDER_LIFETIME_IN_SECONDS = 7;

    let counter = 0;

    const marketPubkey = new PublicKey(
      "4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg"
    );  
    const endpoint = "https://api.mainnet-beta.solana.com";
    const connection = new Connection(endpoint);

    //@ts-ignore
    let privateKeyArray = JSON.parse(process.env.PRIVATE_KEY);

    // Load in the keypair for the trader you wish to trade with
    let traderKeypair = Keypair.fromSecretKey(
      Uint8Array.from(
          // Enter your secretKey here by replacing the empty array.
          privateKeyArray
      )
    );

    // Create a Phoenix Client
    const client = await phoenixSdk.Client.create(connection);
    // Get the market metadata for the market you wish to trade on
    const marketState = client.marketStates.get(marketPubkey.toString());
    const marketData = marketState?.data;
    if (!marketData) {
      throw new Error("Market data not found");
    }

    const setupNewMakerIxs = await phoenixSdk.getMakerSetupInstructionsForMarket(
      connection,
      marketState,
      traderKeypair.publicKey
    );
    console.log("setupNewMakerIxs length: ", setupNewMakerIxs.length);
    if (setupNewMakerIxs.length !== 0) {
      const setupTx = new Transaction().add(...setupNewMakerIxs);
      const setupTxId = await sendAndConfirmTransaction(
        connection,
        setupTx,
        [traderKeypair],
        {
          skipPreflight: true,
          commitment: "confirmed",
        }
      );
      console.log(
        `Setup Tx Link: https://solscan.io/tx/${setupTxId}`
      );
    } else {
      console.log("No setup required. Continuing...");
    }
  

    do {

      // Before quoting, we cancel all outstanding orders
      const cancelAll = client.createCancelAllOrdersInstruction(
        marketPubkey.toString(),
        traderKeypair.publicKey
      );

      // Note we could bundle this with the place order transaction below, but we choose to cancel
      // seperately since getting the price could take an non-deterministic amount of time
      try {
        const cancelTransaction = new Transaction().add(cancelAll);
        const txid = await sendAndConfirmTransaction(
          connection,
          cancelTransaction,
          [traderKeypair],
          {
            skipPreflight: true,
            commitment: "confirmed",
          }
        );

        console.log(
          `Cancel tx link: https://solscan.io/tx/${txid}`
        );
      } catch (err) {
        console.log("Error: ", err);
        continue;
      }

      // Get current SOL price from Coinbase
      const price = await fetch("https://api.coinbase.com/v2/prices/SOL-USD/spot")
      .then((response) => response.json())
      .then((data) => {
        return data.data.amount;
      })
      .catch((error) => console.error(error));

      let bidPrice = parseFloat(price) - EDGE;
      let askPrice = parseFloat(price) + EDGE;

      console.log(`SOL price: ${price}`);
      console.log(`Placing bid (buy) order at: ${bidPrice}`);
      console.log(`Placing ask (sell) order at: ${askPrice}`);

      const currentTime = Math.floor(Date.now() / 1000);

      const bidOrderTemplate: phoenixSdk.LimitOrderTemplate = {
        side: phoenixSdk.Side.Bid,
        priceAsFloat: bidPrice,
        sizeInBaseUnits: 1,
        selfTradeBehavior: phoenixSdk.SelfTradeBehavior.Abort,
        clientOrderId: 1,
        useOnlyDepositedFunds: false,
        lastValidSlot: undefined,
        lastValidUnixTimestampInSeconds: currentTime + ORDER_LIFETIME_IN_SECONDS,
      };

      const bidLimitOrderIx = client.getLimitOrderInstructionfromTemplate(
        marketPubkey.toBase58(),
        traderKeypair.publicKey,
        bidOrderTemplate
      );

      const askOrderTemplate: phoenixSdk.LimitOrderTemplate = {
        side: phoenixSdk.Side.Ask,
        priceAsFloat: askPrice,
        sizeInBaseUnits: 1,
        selfTradeBehavior: phoenixSdk.SelfTradeBehavior.Abort,
        clientOrderId: 1,
        useOnlyDepositedFunds: false,
        lastValidSlot: undefined,
        lastValidUnixTimestampInSeconds: currentTime + ORDER_LIFETIME_IN_SECONDS,
      };
      const askLimitOrderIx = client.getLimitOrderInstructionfromTemplate(
        marketPubkey.toBase58(),
        traderKeypair.publicKey,
        askOrderTemplate
      );
      let instructions: TransactionInstruction[] = [];
      if(counter < MAX_ITERATIONS) {
        instructions = [bidLimitOrderIx, askLimitOrderIx];
      }

      if(counter === MAX_ITERATIONS) {
        // Create WithdrawParams. Setting params to null will withdraw all funds
        const withdrawParams: phoenixSdk.WithdrawParams = {
          quoteLotsToWithdraw: null,
          baseLotsToWithdraw: null,
        };

        const placeWithdraw = client.createWithdrawFundsInstruction(
          {
            withdrawFundsParams: withdrawParams,
          },
          marketPubkey.toString(),
          traderKeypair.publicKey
        );
        instructions.push(placeWithdraw);
      }

      // Send place orders/withdraw transaction
      try {
        const placeQuotesTx = new Transaction().add(...instructions);

        const placeQuotesTxId = await sendAndConfirmTransaction(
          connection,
          placeQuotesTx,
          [traderKeypair],
          {
            skipPreflight: true,
            commitment: "confirmed",
          }
        );

        console.log(
          "Place quotes",
          bidPrice.toFixed(marketState.getPriceDecimalPlaces()),
          "@",
          askPrice.toFixed(marketState.getPriceDecimalPlaces())
        );
        console.log(
          `Tx link: https://solscan.io/tx/${placeQuotesTxId}`
        );
      } catch (err) {
        console.log("Error: ", err);
        continue;
      }

      counter += 1;

      await delay(REFRESH_FREQUENCY_IN_MS);
    }
    while(counter < MAX_ITERATIONS);

}

export const delay = (time: number) => {
  return new Promise((resolve) => setTimeout(resolve, time));
};

execute();