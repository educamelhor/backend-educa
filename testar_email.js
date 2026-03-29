// testar_email.js
import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config();

async function enviarEmailTeste() {
  try {
    // Configura o transporte
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT,
      secure: false, // TLS
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    // Envia o e-mail
    const info = await transporter.sendMail({
      from: `"Sistema EducaMelhor" <${process.env.SMTP_USER}>`,
      to: process.env.SMTP_USER, // envia para você mesmo
      subject: "Teste SMTP - EducaMelhor",
      text: "Este é um e-mail de teste enviado com Nodemailer + Gmail.",
    });

    console.log("E-mail enviado com sucesso! ID:", info.messageId);
  } catch (error) {
    console.error("Erro ao enviar e-mail:", error);
  }
}

enviarEmailTeste();
