// Payment adapter. "mock" works offline; "paytm" uses Dynamic QR (needs enterprise access + MID/key).
import QRCode from "qrcode";
// SVG, not PNG: ~50x cheaper to produce, so QR generation never dominates the server CPU when many shops check out at once
const qrImage = async (text) => "data:image/svg+xml;base64," + Buffer.from(await QRCode.toString(text, { type: "svg", margin: 2, errorCorrectionLevel: "M" })).toString("base64");
import { menu } from "./orders.js";
const mode = () => (process.env.PAYMENT_MODE || "mock");

export async function createQr(order) {
  if (mode() === "paytm") {
    const { default: PaytmChecksum } = await import("paytmchecksum");
    const body = {
      mid: process.env.PAYTM_MID, orderId: order.id, amount: order.total.toFixed(2),
      businessType: "UPI_QR_CODE", posId: process.env.PAYTM_POS_ID || "S1_1",
    };
    const signature = await PaytmChecksum.generateSignature(JSON.stringify(body), process.env.PAYTM_MERCHANT_KEY);
    const r = await fetch(`${process.env.PAYTM_HOST}/paymentservices/qr/create`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ head: { clientId: "C11", version: "v1", signature }, body }),
    });
    const j = await r.json();
    const qrData = j?.body?.qrData;
    if (!qrData) throw new Error("Paytm QR create failed: " + JSON.stringify(j?.body?.resultInfo || j));
    return qrImage(qrData);
  }
  return qrImage(`upi://pay?pa=demo@paytm&pn=${encodeURIComponent(menu.shop)}&am=${order.total.toFixed(2)}&cu=INR&tn=${order.id}`);
}

// Returns true only when the provider confirms a terminal SUCCESS. Never trust the client.
export async function verifyPaid(order) {
  if (mode() === "paytm") {
    const { default: PaytmChecksum } = await import("paytmchecksum");
    const body = { mid: process.env.PAYTM_MID, orderId: order.id };
    const signature = await PaytmChecksum.generateSignature(JSON.stringify(body), process.env.PAYTM_MERCHANT_KEY);
    const r = await fetch(`${process.env.PAYTM_HOST}/v3/order/status`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ head: { signature }, body }),
    });
    const j = await r.json();
    return j?.body?.resultInfo?.resultStatus === "TXN_SUCCESS";
  }
  return order.mockPaid === true;
}
export const isMock = () => mode() !== "paytm";
