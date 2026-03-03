import oracledb from 'oracledb';

let pool = null;

export async function initPool() {
    if (pool) return pool;
    pool = await oracledb.createPool({
        user: process.env.ORACLE_USER,
        password: process.env.ORACLE_PASSWORD,
        connectString: process.env.ORACLE_CONNECTION_STRING,
        poolMin: 2,
        poolMax: 10,
        poolIncrement: 1,
    });
    console.log('[oracle] Pool creato');
    return pool;
}

export async function closePool() {
    if (pool) {
        await pool.close(0);
        pool = null;
    }
}

/**
 * Recupera i metadati di un documento dal DB Oracle per nome file.
 * NON recupera il BLOB, solo i metadati.
 */
export async function getDocumentMetadata(docName) {
    const conn = await pool.getConnection();
    try {
        const result = await conn.execute(
            `SELECT
                d.NAME              AS nome_file,
                d.MIME_TYPE,
                d.DOC_SIZE,
                d.CONTENT_TYPE,
                det.DS_DOC          AS descrizione,
                det.CD_TIP          AS tipo_documento,
                det.DT_INS          AS data_inserimento,
                det.DT_DOC          AS data_documento,
                det.DT_RIF          AS data_riferimento,
                det.CD_USR          AS utente,
                det.CD_SOC          AS societa,
                det.CD_ABS          AS abstract,
                det.FL_ALL          AS flag_allegato,
                det.NN_LIV_DOC      AS livello_riservatezza
            FROM DOCLIGHT.TD000_DOC d
            JOIN DOCLIGHT.TD001_DOC_DET det ON det.CD_DOC = d.NAME
            WHERE d.NAME = :docName`,
            { docName },
            { outFormat: oracledb.OUT_FORMAT_OBJECT },
        );
        return result.rows[0] || null;
    } finally {
        await conn.close();
    }
}

/**
 * Recupera i metadati di più documenti in un'unica query.
 */
export async function getDocumentsMetadataBatch(docNames) {
    if (!docNames.length) return [];
    const conn = await pool.getConnection();
    try {
        // Usa una IN clause con bind variables dinamiche
        const binds = {};
        const placeholders = docNames.map((name, i) => {
            binds[`n${i}`] = name;
            return `:n${i}`;
        });

        const result = await conn.execute(
            `SELECT
                d.NAME              AS nome_file,
                d.MIME_TYPE,
                d.DOC_SIZE,
                d.CONTENT_TYPE,
                det.DS_DOC          AS descrizione,
                det.CD_TIP          AS tipo_documento,
                det.DT_INS          AS data_inserimento,
                det.DT_DOC          AS data_documento,
                det.DT_RIF          AS data_riferimento,
                det.CD_USR          AS utente,
                det.CD_SOC          AS societa,
                det.CD_ABS          AS abstract,
                det.FL_ALL          AS flag_allegato,
                det.NN_LIV_DOC      AS livello_riservatezza
            FROM DOCLIGHT.TD000_DOC d
            JOIN DOCLIGHT.TD001_DOC_DET det ON det.CD_DOC = d.NAME
            WHERE d.NAME IN (${placeholders.join(',')})`,
            binds,
            { outFormat: oracledb.OUT_FORMAT_OBJECT },
        );
        return result.rows;
    } finally {
        await conn.close();
    }
}

/**
 * Recupera il contenuto binario di un documento (BLOB/BFILE) + MIME type.
 */
export async function getDocumentContent(docName) {
    const conn = await pool.getConnection();
    try {
        const result = await conn.execute(
            `SELECT
                d.MIME_TYPE,
                d.NAME,
                DOCLIGHT.FN_GET_DOC_CONTENT(d.NAME) AS FILE_CONTENT
            FROM DOCLIGHT.TD000_DOC d
            WHERE d.NAME = :docName`,
            { docName },
            { outFormat: oracledb.OUT_FORMAT_OBJECT, fetchInfo: { FILE_CONTENT: { type: oracledb.BUFFER } } },
        );

        if (!result.rows.length) return null;

        const row = result.rows[0];
        let buffer = row.FILE_CONTENT;

        // Se il risultato è un LOB, leggiamo il contenuto
        if (buffer && typeof buffer.read === 'function') {
            const chunks = [];
            await new Promise((resolve, reject) => {
                buffer.on('data', chunk => chunks.push(chunk));
                buffer.on('end', resolve);
                buffer.on('error', reject);
            });
            buffer = Buffer.concat(chunks);
        }

        return {
            content: buffer,
            mimeType: row.MIME_TYPE || 'application/octet-stream',
            name: row.NAME,
        };
    } finally {
        await conn.close();
    }
}

/**
 * Recupera gli allegati di un documento.
 */
export async function getAttachmentNames(docName) {
    const conn = await pool.getConnection();
    try {
        const result = await conn.execute(
            `SELECT
                a.CD_DOC_ALL        AS nome_allegato,
                det.DS_DOC          AS descrizione,
                det.CD_TIP          AS tipo_documento,
                d.MIME_TYPE,
                d.DOC_SIZE
            FROM DOCLIGHT.TD016_DOC_ALL a
            JOIN DOCLIGHT.TD001_DOC_DET det ON det.CD_DOC = a.CD_DOC_ALL
            JOIN DOCLIGHT.TD000_DOC d ON d.NAME = a.CD_DOC_ALL
            WHERE a.CD_DOC = :docName`,
            { docName },
            { outFormat: oracledb.OUT_FORMAT_OBJECT },
        );
        return result.rows;
    } finally {
        await conn.close();
    }
}
