import oracledb from 'oracledb';

let pool = null;

/**
 * Inizializza il connection pool Oracle
 */
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

/**
 * Chiude il connection pool
 */
export async function closePool() {
    if (pool) {
        await pool.close(0);
        pool = null;
        console.log('[oracle] Pool chiuso');
    }
}

/**
 * Conta i documenti disponibili
 */
export async function countDocuments() {
    const conn = await pool.getConnection();
    try {
        const result = await conn.execute(
            `SELECT COUNT(*) AS CNT
             FROM DOCLIGHT.TD000_DOC d
             JOIN DOCLIGHT.TD001_DOC_DET det ON det.CD_DOC = d.NAME`,
        );
        return result.rows[0][0];
    } finally {
        await conn.close();
    }
}

/**
 * Recupera una pagina di documenti con metadati (senza BLOB, per listing)
 */
export async function listDocuments({ offset = 0, limit = 50 } = {}) {
    const conn = await pool.getConnection();
    try {
        const result = await conn.execute(
            `SELECT * FROM (
                SELECT
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
                    det.NN_LIV_DOC      AS livello_riservatezza,
                    ROW_NUMBER() OVER (ORDER BY det.DT_INS DESC) AS rn
                FROM DOCLIGHT.TD000_DOC d
                JOIN DOCLIGHT.TD001_DOC_DET det ON det.CD_DOC = d.NAME
            )
            WHERE rn > :offset AND rn <= :offset + :limit`,
            { offset, limit },
            { outFormat: oracledb.OUT_FORMAT_OBJECT },
        );
        return result.rows;
    } finally {
        await conn.close();
    }
}

/**
 * Recupera il contenuto binario di un documento (BLOB o BFILE unificati)
 * Usa la funzione FN_GET_DOC_CONTENT per leggere sia BLOB che BFILE
 */
export async function getDocumentContent(docName) {
    const conn = await pool.getConnection();
    try {
        const result = await conn.execute(
            `SELECT
                d.NAME              AS nome_file,
                d.MIME_TYPE,
                d.DOC_SIZE,
                d.CONTENT_TYPE,
                DOCLIGHT.FN_GET_DOC_CONTENT(d.NAME) AS file_content,
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
            { outFormat: oracledb.OUT_FORMAT_OBJECT, fetchInfo: { FILE_CONTENT: { type: oracledb.BUFFER } } },
        );
        if (!result.rows.length) return null;

        const row = result.rows[0];

        // Converte il LOB in Buffer se necessario
        if (row.FILE_CONTENT && typeof row.FILE_CONTENT.getData === 'function') {
            row.FILE_CONTENT = await row.FILE_CONTENT.getData();
        }

        return row;
    } finally {
        await conn.close();
    }
}

/**
 * Recupera i documenti a batch per l'ingestion, includendo il contenuto binario
 */
export async function getDocumentsBatch({ offset = 0, limit = 10 } = {}) {
    const conn = await pool.getConnection();
    try {
        const result = await conn.execute(
            `SELECT * FROM (
                SELECT
                    d.NAME              AS nome_file,
                    d.MIME_TYPE,
                    d.DOC_SIZE,
                    d.CONTENT_TYPE,
                    DOCLIGHT.FN_GET_DOC_CONTENT(d.NAME) AS file_content,
                    det.DS_DOC          AS descrizione,
                    det.CD_TIP          AS tipo_documento,
                    det.DT_INS          AS data_inserimento,
                    det.DT_DOC          AS data_documento,
                    det.DT_RIF          AS data_riferimento,
                    det.CD_USR          AS utente,
                    det.CD_SOC          AS societa,
                    det.CD_ABS          AS abstract,
                    det.FL_ALL          AS flag_allegato,
                    det.NN_LIV_DOC      AS livello_riservatezza,
                    ROW_NUMBER() OVER (ORDER BY det.DT_INS DESC) AS rn
                FROM DOCLIGHT.TD000_DOC d
                JOIN DOCLIGHT.TD001_DOC_DET det ON det.CD_DOC = d.NAME
            )
            WHERE rn > :offset AND rn <= :offset + :limit`,
            { offset, limit },
            { outFormat: oracledb.OUT_FORMAT_OBJECT },
        );

        // Converte tutti i LOB in Buffer
        for (const row of result.rows) {
            if (row.FILE_CONTENT && typeof row.FILE_CONTENT.getData === 'function') {
                row.FILE_CONTENT = await row.FILE_CONTENT.getData();
            }
        }

        return result.rows;
    } finally {
        await conn.close();
    }
}

/**
 * Recupera gli allegati di un documento padre
 */
export async function getAttachments(docName) {
    const conn = await pool.getConnection();
    try {
        const result = await conn.execute(
            `SELECT
                d.NAME              AS nome_file,
                d.MIME_TYPE,
                d.DOC_SIZE,
                DOCLIGHT.FN_GET_DOC_CONTENT(d.NAME) AS file_content,
                det.DS_DOC          AS descrizione,
                det.CD_TIP          AS tipo_documento
            FROM DOCLIGHT.TD016_DOC_ALL a
            JOIN DOCLIGHT.TD001_DOC_DET det ON det.CD_DOC = a.CD_DOC_ALL
            JOIN DOCLIGHT.TD000_DOC d ON d.NAME = a.CD_DOC_ALL
            WHERE a.CD_DOC = :docName`,
            { docName },
            { outFormat: oracledb.OUT_FORMAT_OBJECT },
        );

        for (const row of result.rows) {
            if (row.FILE_CONTENT && typeof row.FILE_CONTENT.getData === 'function') {
                row.FILE_CONTENT = await row.FILE_CONTENT.getData();
            }
        }

        return result.rows;
    } finally {
        await conn.close();
    }
}

/**
 * Recupera i tipi documento disponibili
 */
export async function getDocumentTypes() {
    const conn = await pool.getConnection();
    try {
        const result = await conn.execute(
            `SELECT CD_TIP, DS_TIP, CD_CAT, FL_MEM
             FROM DOCLIGHT.TD002_DOC_TIP
             ORDER BY CD_TIP`,
            {},
            { outFormat: oracledb.OUT_FORMAT_OBJECT },
        );
        return result.rows;
    } finally {
        await conn.close();
    }
}
