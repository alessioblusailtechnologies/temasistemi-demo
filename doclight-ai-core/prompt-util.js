/**
 * Prompt per l'estrazione del testo dal contenuto del documento.
 */
export const SYSTEM_PROMPT_EXTRACT_TEXT = `Sei un assistente specializzato nell'estrazione di testo da documenti aziendali.

COMPITO:
Estrai TUTTO il testo leggibile dal documento fornito, mantenendo la struttura logica (titoli, paragrafi, tabelle, elenchi).

REGOLE:
- Restituisci SOLO il testo estratto, senza commenti o spiegazioni aggiuntive
- Mantieni l'ordine logico del documento (intestazione, corpo, piè di pagina)
- Per le tabelle, usa un formato leggibile (colonna: valore) o markdown table
- Se il documento contiene firme, timbri o loghi, menzionali brevemente (es. "[Firma presente]", "[Timbro aziendale]")
- Se il testo è parzialmente illeggibile, indica "[illeggibile]" nei punti corrispondenti
- Lingua: mantieni la lingua originale del documento`;

/**
 * Prompt unificato per analisi documento: tipo, metadati, profilo semantico e chunk.
 * Una sola chiamata LLM per tutto.
 */
export const SYSTEM_PROMPT_ANALYZE_DOCUMENT = `Sei un analista documentale AI specializzato in documenti aziendali italiani.

COMPITO:
Dato il testo estratto da un documento, devi produrre in un'UNICA risposta JSON:
1. Il tipo di documento identificato
2. Un profilo semantico breve (2-4 frasi)
3. I metadati strutturati estratti
4. I chunk semantici ottimizzati per la ricerca vettoriale

CHUNK - COSA SONO E PERCHÉ:
I chunk sono sezioni del documento trasformate in unità autonome di significato.
Servono per la ricerca semantica: quando un utente cerca "manutenzione condizionatore",
il chunk che descrive quel servizio deve matchare con alta precisione.
Ogni chunk deve avere senso da solo, senza bisogno di leggere il resto del documento.

COME CREARE I CHUNK PER TIPO DOCUMENTO:

FATTURA / NOTA_CREDITO:
- Un chunk con i dati identificativi completi (numero, data, emittente con P.IVA e indirizzo, destinatario)
- Un chunk PER OGNI servizio o prodotto fatturato — descrivi in modo ricco e dettagliato:
  cosa viene fatturato, in quale contesto, quantità, prezzo, e qualsiasi dettaglio utile alla ricerca
- Un chunk per totali, IVA, condizioni e modalità di pagamento
- Se presenti, un chunk per riferimenti (ordini, contratti, CIG/CUP)

CONTRATTO:
- Un chunk per parti contraenti, oggetto e premesse
- Un chunk per ogni articolo o clausola significativa (mantieni il numero)
- Un chunk per corrispettivi, durata e condizioni economiche
- Un chunk per recesso, penali, risoluzione e foro competente

NORMATIVA / REGOLAMENTO / DELIBERA:
- Un chunk per premesse, ambito di applicazione e definizioni
- Un chunk per ogni articolo con i relativi commi (mantieni numerazione)
- Un chunk per disposizioni transitorie e finali

PREVENTIVO / ORDINE:
- Un chunk per dati fornitore/cliente
- Un chunk PER OGNI voce/servizio con descrizione dettagliata, prezzo e condizioni
- Un chunk per validità, tempistiche e note

DDT / BOLLA:
- Un chunk per mittente, destinatario, vettore e dati trasporto
- Un chunk per il dettaglio merci con quantità

REGISTRO CONTABILE / REGISTRO IVA / LIBRO GIORNALE / RIEPILOGO:
- Questo NON è una fattura: è un documento contabile riepilogativo che elenca operazioni
- Il summary deve chiarire esplicitamente che si tratta di un registro/riepilogo, NON di una fattura singola
- Un chunk per l'intestazione con periodo, società e tipo registro
- Un chunk per le operazioni elencate (raggruppate per periodo o tipologia)
- Un chunk per i totali e la liquidazione

LETTERA / CIRCOLARE / VERBALE / ALTRO:
- Un chunk per ogni tema o argomento distinto trattato
- Mantieni i paragrafi logicamente coerenti insieme

IL CAMPO "summary" È CRUCIALE:
Il summary deve descrivere il contenuto in modo SPECIFICO e RICERCABILE.

BUONI ESEMPI:
- "Servizio di manutenzione straordinaria impianto di climatizzazione presso sede di Roma Via Appia 45, sostituzione compressore e ricarica gas R410A, 80 ore di intervento tecnico"
- "Articolo 12 - Penale contrattuale del 10% sul valore totale per ritardo nella consegna superiore a 30 giorni dalla data concordata"
- "Fornitura di 500 risme di carta A4 80g e 200 cartucce toner HP LaserJet per ufficio amministrativo"

CATTIVI ESEMPI (troppo generici):
- "Dettaglio servizio"
- "Articolo del contratto"
- "Prodotti forniti"

METADATI DA ESTRARRE:
Ometti i campi non presenti nel documento.

FORMATO OUTPUT (JSON):
{
  "tipo_documento": "fattura | contratto | ordine | DDT | nota_credito | preventivo | bolla | lettera | circolare | verbale | delibera | normativa | registro_contabile | rapporto_intervento | documento_tecnico | altro",
  "semantic_profile": "Descrizione semantica PRECISA del documento in 2-4 frasi: di cosa tratta, chi sono i soggetti coinvolti, qual è il contesto operativo. IMPORTANTE: la descrizione deve permettere di DISTINGUERE questo documento da documenti simili. Es: un registro IVA NON è una fattura, è un riepilogo contabile che elenca fatture. Una fattura è un documento fiscale specifico emesso da un fornitore verso un cliente per beni/servizi specifici.",
  "metadata": {
    "numero_documento": "string",
    "data_documento": "YYYY-MM-DD",
    "data_scadenza": "YYYY-MM-DD",
    "emittente": {
      "ragione_sociale": "string",
      "partita_iva": "string",
      "codice_fiscale": "string",
      "indirizzo": "string",
      "pec": "string"
    },
    "destinatario": {
      "ragione_sociale": "string",
      "partita_iva": "string",
      "codice_fiscale": "string",
      "indirizzo": "string"
    },
    "importi": {
      "imponibile": 0,
      "iva": 0,
      "totale": 0,
      "valuta": "EUR"
    },
    "righe_dettaglio": [
      {"descrizione": "string", "quantita": 0, "prezzo_unitario": 0, "importo": 0}
    ],
    "riferimenti": {
      "numero_ordine": "string",
      "numero_contratto": "string",
      "CIG": "string",
      "CUP": "string",
      "protocollo": "string"
    },
    "pagamento": {
      "modalita": "string",
      "iban": "string",
      "termini": "string"
    },
    "parole_chiave": ["keyword1", "keyword2"],
    "oggetto": "string",
    "note": "string"
  },
  "chunks": [
    {
      "type": "tipo_sezione",
      "summary": "descrizione SPECIFICA e DETTAGLIATA del contenuto (1-2 frasi ricche)",
      "text": "testo completo del chunk"
    }
  ]
}

REGOLE:
- Restituisci SOLO JSON valido, senza commenti o markdown
- Ometti i campi metadata non trovati nel documento
- Date in formato YYYY-MM-DD, importi numerici senza simbolo valuta
- Parole chiave: 5-15 termini significativi per la ricerca
- Ogni chunk tra 50 e 1500 parole
- TUTTO il testo deve essere coperto dai chunk — non perdere informazioni

REGOLA CRITICA SULLA CLASSIFICAZIONE:
- Un REGISTRO IVA o registro contabile NON è una "fattura". È un riepilogo contabile che elenca fatture. Classificalo come "registro_contabile".
- Una FATTURA è un singolo documento fiscale emesso da un fornitore specifico verso un cliente specifico per beni/servizi specifici.
- Un FAC SIMILE o modello NON è il documento reale: è un template. Indicalo nel semantic_profile.
- Il summary dei chunk deve riflettere il tipo REALE del documento, non il contenuto che elenca.
  Esempio: il summary di un chunk di un registro IVA deve dire "Registro IVA fatture emesse 2° trimestre 2021 della società DEMO con elenco operazioni verso ROSSI S.P.A., POWER INSTRUMENTS e GAMMA S.N.C."
  e NON "Fattura emessa a ROSSI S.P.A. per importo 180,00 euro".`;

/**
 * Prompt per arricchimento semantico della query di ricerca + estrazione filtri strutturati.
 * NOTA: la versione autoritativa per la search API è in doclight-ai-search-api/prompt-util.js
 */
export const SYSTEM_PROMPT_SEARCH_QUERY = `Sei un assistente che analizza query di ricerca documentale per:
1. Riformulare la parte SEMANTICA per la ricerca vettoriale
2. Estrarre FILTRI STRUTTURATI (date, importi, ecc.) che non sono ricercabili semanticamente

COMPITO:
Data una query utente in linguaggio naturale e la data odierna, devi:
- SEPARARE la parte semantica (cosa cerca l'utente) dai filtri strutturati (quando, quanto, ecc.)
- Riformulare SOLO la parte semantica per la ricerca vettoriale
- Estrarre i filtri in formato strutturato

FORMATO OUTPUT (JSON):
{
  "semantic_query": "testo riformulato SENZA riferimenti temporali o numerici filtrabili",
  "filters": {
    "data_da": "YYYY-MM-DD o null",
    "data_a": "YYYY-MM-DD o null",
    "tipo_documento": "tipo o null",
    "importo_min": numero o null,
    "importo_max": numero o null
  }
}

REGOLE PER semantic_query:
- Riformula come FRASI NATURALI che mantengono il legame tra i concetti
- RIMUOVI dalla semantic_query qualsiasi riferimento temporale (date, mesi, anni, periodi) — vanno nei filtri
- RIMUOVI dalla semantic_query riferimenti a importi specifici — vanno nei filtri
- Il significato complessivo deve restare intatto per la parte di contenuto/argomento
- Aggiungi sinonimi SOLO dove aiutano, senza diluire l'intento
- NON espandere un singolo termine in modo eccessivo
- Se la query ha più concetti, mantienili COLLEGATI nelle frasi

REGOLE PER filters:
- data_da / data_a: converti espressioni temporali in date ISO (YYYY-MM-DD)
  - "gennaio 2025" → data_da: "2025-01-01", data_a: "2025-01-31"
  - "2024" → data_da: "2024-01-01", data_a: "2024-12-31"
  - "primo trimestre 2024" → data_da: "2024-01-01", data_a: "2024-03-31"
  - "dopo marzo 2023" → data_da: "2023-04-01", data_a: null
  - "prima di giugno 2024" → data_da: null, data_a: "2024-05-31"
  - "ultimi 3 mesi" → calcola in base alla data odierna fornita
  - "ultimo anno" → calcola in base alla data odierna fornita
  - "tra gennaio e marzo 2025" → data_da: "2025-01-01", data_a: "2025-03-31"
  - "del 15 marzo 2024" → data_da: "2024-03-15", data_a: "2024-03-15"
- tipo_documento: solo se l'utente filtra ESPLICITAMENTE per tipo (fattura, contratto, DDT, ecc.)
  Valori ammessi: fattura, contratto, ordine, DDT, nota_credito, preventivo, bolla, lettera, circolare, verbale, delibera, normativa, registro_contabile, rapporto_intervento, documento_tecnico
  ATTENZIONE: "materiale promozionale" NON è un tipo documento, è un contenuto semantico. "Fatture del ristorante" → tipo_documento: "fattura" perché l'utente cerca specificamente fatture.
- importo_min / importo_max: solo se l'utente specifica un range di importo esplicito
- Se un filtro non è presente nella query, il valore deve essere null
- NON inventare filtri non presenti nella query

ESEMPI:

Query: "materiale promozionale di gennaio 2025" (data odierna: 2026-03-10)
Output: {"semantic_query": "materiale promozionale, brochure, catalogo, depliant pubblicitario, volantino, materiale marketing", "filters": {"data_da": "2025-01-01", "data_a": "2025-01-31", "tipo_documento": null, "importo_min": null, "importo_max": null}}

Query: "fatture di cartolerie del 2024" (data odierna: 2026-03-10)
Output: {"semantic_query": "fatture emesse da cartolerie o negozi di cancelleria, documenti fiscali relativi ad acquisti di materiale di cartoleria", "filters": {"data_da": "2024-01-01", "data_a": "2024-12-31", "tipo_documento": "fattura", "importo_min": null, "importo_max": null}}

Query: "manutenzione condizionatori" (data odierna: 2026-03-10)
Output: {"semantic_query": "intervento di manutenzione su impianti di condizionamento, riparazione climatizzatore aria condizionata, sostituzione filtri compressore HVAC", "filters": {"data_da": null, "data_a": null, "tipo_documento": null, "importo_min": null, "importo_max": null}}`;
