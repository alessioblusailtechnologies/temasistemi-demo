import nodemailer from 'nodemailer';

function createTransporter() {
    const host = process.env.SMTP_HOST;
    const port = parseInt(process.env.SMTP_PORT || '587', 10);
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;

    if (!host) {
        throw new Error(
            'Configurazione SMTP mancante. Aggiungi SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS al file .env'
        );
    }

    console.log(`[mailer] SMTP config: host=${host}, port=${port}, user=${user}, pass=${pass ? pass.substring(0, 4) + '...' : 'MISSING'}`);

    return nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: user ? { user, pass } : undefined,
    });
}

/**
 * Invia una email con allegati opzionali.
 *
 * @param {object} opts
 * @param {string} opts.to          - Destinatario
 * @param {string} opts.subject     - Oggetto
 * @param {string} opts.text        - Corpo testo
 * @param {string} [opts.html]      - Corpo HTML
 * @param {Array}  [opts.attachments] - Allegati [{filename, content, contentType}]
 */
export async function sendEmail({ to, subject, text, html, attachments = [] }) {
    const transport = createTransporter();
    const from = process.env.SMTP_FROM || process.env.SMTP_USER || 'doclight@noreply.local';

    const info = await transport.sendMail({
        from,
        to,
        subject,
        text,
        html,
        attachments,
    });

    console.log(`[mailer] Email inviata a ${to} — messageId: ${info.messageId}`);
    return info;
}
