import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface SearchRequest {
  query: string;
  top_k?: number;
}

export interface MetadataAI {
  tipo_documento?: string;
  numero_documento?: string;
  data_documento?: string;
  data_scadenza?: string;
  oggetto?: string;
  emittente?: { ragione_sociale?: string; partita_iva?: string };
  destinatario?: { ragione_sociale?: string; partita_iva?: string };
  importi?: { imponibile?: number; iva?: number; totale?: number; valuta?: string };
  parole_chiave?: string[];
  [key: string]: any;
}

export interface MetadataDB {
  descrizione?: string;
  tipo_documento?: string;
  data_inserimento?: string;
  data_documento?: string;
  data_riferimento?: string;
  utente?: string;
  societa?: string;
  abstract?: string;
  flag_allegato?: string;
  livello_riservatezza?: number;
  mime_type?: string;
  doc_size?: number;
  content_type?: string;
}

export interface SearchResult {
  nome_file: string;
  score: number;
  score_percent: number;
  semantic_profile: string;
  metadata_ai: MetadataAI | null;
  metadata_db: MetadataDB | null;
}

export interface SearchResponse {
  query: string;
  interpreted: {
    semantic_query: string;
    filters: any;
  };
  results: SearchResult[];
  total: number;
  elapsed_ms: number;
}

@Injectable({ providedIn: 'root' })
export class SearchService {
  private readonly apiUrl = '/api';

  constructor(private http: HttpClient) {}

  search(request: SearchRequest): Observable<SearchResponse> {
    return this.http.post<SearchResponse>(`${this.apiUrl}/search`, request);
  }
}
