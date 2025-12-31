// services/mailer.js
import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  host: process.env.MAIL_HOST,
  port: Number(process.env.MAIL_PORT || 587),
  secure: false, // se usar porta 465, mude para true
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS,
  },
});

export async function enviarEmail({ to, subject, text, html }) {
  const info = await transporter.sendMail({
    from: `"EDUCA.MELHOR" <${process.env.MAIL_FROM || process.env.MAIL_USER}>`,
    to,
    subject,
    text,
    html,
  });

  console.log("[MAILER] E-mail enviado:", info.messageId);
  return info;
}
