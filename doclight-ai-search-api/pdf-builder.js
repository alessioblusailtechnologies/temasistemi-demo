import PDFDocument from 'pdfkit';

/**
 * Genera un PDF con titolo, contenuto testuale del report e tabella documenti.
 * Restituisce un Buffer.
 *
 * @param {string} title       - Titolo del report
 * @param {string} content     - Contenuto testuale generato dal LLM
 * @param {Array}  documents   - Lista documenti trovati
 * @returns {Promise<Buffer>}
 */
export async function buildPdf(title, content, documents = []) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        const doc = new PDFDocument({
            size: 'A4',
            margins: { top: 60, bottom: 60, left: 50, right: 50 },
            info: {
                Title: title,
                Author: 'DocLight AI',
                Creator: 'DocLight AI Agent',
            },
        });

        doc.on('data', (chunk) => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

        // ── Header ──
        doc.rect(0, 0, doc.page.width, 80).fill('#1976D2');
        doc.fill('#FFFFFF').fontSize(22).font('Helvetica-Bold')
            .text(title, 50, 25, { width: pageWidth });
        doc.fontSize(10).font('Helvetica')
            .text(`Generato da DocLight AI — ${new Date().toLocaleDateString('it-IT', {
                day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
            })}`, 50, 52, { width: pageWidth });

        doc.fill('#212121');
        doc.y = 100;

        // ── Contenuto report ──
        doc.fontSize(11).font('Helvetica').lineGap(4);
        const lines = content.split('\n');
        for (const line of lines) {
            if (doc.y > doc.page.height - 80) {
                doc.addPage();
            }

            const trimmed = line.trim();

            // Heading (## o ###)
            if (trimmed.startsWith('### ')) {
                doc.moveDown(0.5);
                doc.fontSize(12).font('Helvetica-Bold')
                    .text(trimmed.replace(/^###\s*/, ''), { width: pageWidth });
                doc.fontSize(11).font('Helvetica');
                doc.moveDown(0.3);
            } else if (trimmed.startsWith('## ')) {
                doc.moveDown(0.8);
                doc.fontSize(14).font('Helvetica-Bold')
                    .text(trimmed.replace(/^##\s*/, ''), { width: pageWidth });
                doc.fontSize(11).font('Helvetica');
                doc.moveDown(0.3);
            } else if (trimmed.startsWith('# ')) {
                doc.moveDown(0.8);
                doc.fontSize(16).font('Helvetica-Bold')
                    .text(trimmed.replace(/^#\s*/, ''), { width: pageWidth });
                doc.fontSize(11).font('Helvetica');
                doc.moveDown(0.5);
            } else if (trimmed.startsWith('- ') || trimmed.startsWith('• ')) {
                // Bullet list
                const bulletText = trimmed.replace(/^[-•]\s*/, '');
                const boldMatch = bulletText.match(/^\*\*(.+?)\*\*:?\s*(.*)/);
                if (boldMatch) {
                    doc.font('Helvetica-Bold').text(`  •  ${boldMatch[1]}`, {
                        continued: boldMatch[2] ? true : false,
                        width: pageWidth,
                    });
                    if (boldMatch[2]) {
                        doc.font('Helvetica').text(`: ${boldMatch[2]}`, { width: pageWidth });
                    }
                } else {
                    doc.text(`  •  ${stripBold(bulletText)}`, { width: pageWidth });
                }
            } else if (trimmed === '') {
                doc.moveDown(0.4);
            } else {
                // Testo normale — gestisci **bold**
                renderRichLine(doc, trimmed, pageWidth);
            }
        }

        // ── Tabella documenti ──
        if (documents.length > 0) {
            doc.addPage();
            doc.fontSize(14).font('Helvetica-Bold')
                .text('Documenti analizzati', { width: pageWidth });
            doc.moveDown(0.5);

            // Header tabella
            const colWidths = [180, 90, 80, 80, pageWidth - 430];
            const headers = ['Nome file', 'Tipo', 'Data', 'Importo', 'Descrizione'];

            let y = doc.y;
            doc.rect(50, y, pageWidth, 20).fill('#1976D2');
            doc.fill('#FFFFFF').fontSize(9).font('Helvetica-Bold');
            let x = 52;
            for (let i = 0; i < headers.length; i++) {
                doc.text(headers[i], x, y + 5, { width: colWidths[i], height: 15 });
                x += colWidths[i];
            }
            doc.fill('#212121');
            y += 22;

            // Righe
            doc.fontSize(8).font('Helvetica');
            for (const [idx, d] of documents.entries()) {
                if (y > doc.page.height - 80) {
                    doc.addPage();
                    y = doc.y;
                }

                const rowBg = idx % 2 === 0 ? '#FFFFFF' : '#F5F5F5';
                doc.rect(50, y, pageWidth, 18).fill(rowBg);
                doc.fill('#212121');

                x = 52;
                const cells = [
                    (d.nome_file || '').substring(0, 40),
                    (d.tipo_documento || '—'),
                    (d.data_documento || '—'),
                    d.importo_totale ? `€${d.importo_totale.toLocaleString('it-IT')}` : '—',
                    (d.descrizione || d.semantic_profile || '').substring(0, 50),
                ];
                for (let i = 0; i < cells.length; i++) {
                    doc.text(cells[i], x, y + 4, { width: colWidths[i], height: 14 });
                    x += colWidths[i];
                }
                y += 20;
            }
        }

        // ── Footer ──
        doc.moveDown(2);
        doc.fontSize(8).fill('#9E9E9E').font('Helvetica')
            .text('Questo report è stato generato automaticamente da DocLight AI.', {
                width: pageWidth, align: 'center',
            });

        doc.end();
    });
}

function stripBold(text) {
    return text.replace(/\*\*(.+?)\*\*/g, '$1');
}

function renderRichLine(doc, text, width) {
    // Gestione semplice di **bold** inline
    const parts = text.split(/(\*\*.+?\*\*)/g);
    if (parts.length === 1) {
        doc.font('Helvetica').text(text, { width });
        return;
    }

    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const isLast = i === parts.length - 1;
        if (part.startsWith('**') && part.endsWith('**')) {
            doc.font('Helvetica-Bold').text(part.slice(2, -2), {
                continued: !isLast, width,
            });
        } else if (part) {
            doc.font('Helvetica').text(part, {
                continued: !isLast, width,
            });
        }
    }
}
