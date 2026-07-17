// testar_sms.js
import twilio from "twilio";
import dotenv from "dotenv";

dotenv.config();

const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);

// Número de destino (seu celular para teste)
const numeroDestino = "+5561999351166";

async function enviarSMS() {
  try {
    const message = await client.messages.create({
      body: "Mensagem de teste do EducaMelhor com Twilio!",
      from: process.env.TWILIO_PHONE,
      to: numeroDestino
    });
    console.log("Mensagem enviada com sucesso! SID:", message.sid);
  } catch (error) {
    console.error("Erro ao enviar SMS:", error);
  }
}

enviarSMS();
