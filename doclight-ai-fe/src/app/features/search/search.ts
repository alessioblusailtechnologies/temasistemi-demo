import { Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { SearchService, SearchResult, SearchResponse } from '../../services/search.service';

interface DisplayResult extends SearchResult {
  relevance: 'alta' | 'media' | 'bassa';
  displayDate: string;
  displayType: string;
  typeClass: string;
}

@Component({
  selector: 'app-search',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './search.html',
  styleUrl: './search.scss'
})
export class SearchComponent {
  query = '';
  loading = false;
  showBanner = false;
  showRelevanceColumn = false;
  bannerText = '';
  results: DisplayResult[] = [];
  interpretedFilters: any = null;
  semanticQuery = '';
  elapsedMs = 0;
  displayFilters: { label: string; value: string; type: 'must' | 'should' | 'must_not' }[] = [];

  suggestions = [
    { label: 'Fattura condizionatore', query: 'Fattura del condizionatore di marzo' },
    { label: 'Contratto fornitura carta', query: 'Contratto fornitura carta ufficio' },
    { label: 'Fatture rete/luce settembre', query: 'Fatture per rete e luce di settembre' },
    { label: 'Nota credito Jumbo', query: 'Nota di credito Jumbo Market' },
    { label: 'DDT settembre', query: 'DDT consegna settembre' },
    { label: 'Tutti i doc di marzo', query: 'Tutti i documenti di marzo 2025' },
  ];

  constructor(private searchService: SearchService) {}

  fillAndSearch(text: string): void {
    this.query = text;
    this.doSearch();
  }

  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.doSearch();
    }
  }

  doSearch(): void {
    const q = this.query.trim();
    if (!q) return;

    this.loading = true;
    this.showBanner = false;
    this.results = [];
    this.showRelevanceColumn = false;
    this.displayFilters = [];

    this.searchService.search({ query: q, top_k: 20 }).subscribe({
      next: (resp: SearchResponse) => {
        this.loading = false;
        this.semanticQuery = resp.interpreted.semantic_query;
        this.interpretedFilters = resp.interpreted.filters;
        this.elapsedMs = resp.elapsed_ms;
        this.displayFilters = this.buildDisplayFilters(resp.interpreted.filters);

        this.results = resp.results.map(r => ({
          ...r,
          score_percent: this.normalizeScore(r.score),
          relevance: this.calcRelevance(r.score),
          displayDate: this.formatDisplayDate(r),
          displayType: this.mapDocType(r),
          typeClass: this.mapTypeClass(r),
        }));

        this.showRelevanceColumn = this.results.length > 0;
        this.showBanner = true;

        const highCount = this.results.filter(r => r.relevance === 'alta').length;
        const typesFound = [...new Set(this.results.map(r => r.displayType))];

        if (this.results.length > 0) {
          this.bannerText = `<strong>${this.results.length} risultati</strong> trovati per "<em>${q}</em>" — ${highCount} ad alta rilevanza, su ${typesFound.length} ${typesFound.length === 1 ? 'tipo documento' : 'tipi documento'} (${this.elapsedMs}ms)`;
        } else {
          this.bannerText = `Nessun risultato per "<em>${q}</em>". Prova a riformulare la ricerca.`;
        }
      },
      error: (err) => {
        this.loading = false;
        this.showBanner = true;
        this.bannerText = `Errore nella ricerca: ${err.message || 'servizio non disponibile'}`;
      }
    });
  }

  closeBanner(): void {
    this.showBanner = false;
  }

  getDownloadUrl(nomeFile: string): string {
    return `/api/document/${encodeURIComponent(nomeFile)}/download`;
  }

  private buildDisplayFilters(filters: any): { label: string; value: string; type: 'must' | 'should' | 'must_not' }[] {
    if (!filters) return [];
    const result: { label: string; value: string; type: 'must' | 'should' | 'must_not' }[] = [];

    const parseGroup = (conditions: any[], type: 'must' | 'should' | 'must_not') => {
      if (!conditions?.length) return;
      for (const cond of conditions) {
        const parsed = this.parseCondition(cond);
        if (parsed) result.push({ ...parsed, type });
      }
    };

    parseGroup(filters.must, 'must');
    parseGroup(filters.should, 'should');
    parseGroup(filters.must_not, 'must_not');

    return result;
  }

  private parseCondition(cond: any): { label: string; value: string } | null {
    if (!cond?.key) return null;

    const label = this.filterKeyToLabel(cond.key);

    if (cond.match) {
      const val = cond.match.value ?? cond.match.text ?? '';
      return { label, value: this.filterValueToDisplay(cond.key, val) };
    }

    if (cond.range) {
      const isDate = this.isDateField(cond.key);
      const parts: string[] = [];
      if (cond.range.gte != null) parts.push(`${isDate ? 'dal' : '≥'} ${this.formatFilterValue(cond.key, cond.range.gte)}`);
      if (cond.range.lte != null) parts.push(`${isDate ? 'al' : '≤'} ${this.formatFilterValue(cond.key, cond.range.lte)}`);
      if (cond.range.gt != null) parts.push(`> ${this.formatFilterValue(cond.key, cond.range.gt)}`);
      if (cond.range.lt != null) parts.push(`< ${this.formatFilterValue(cond.key, cond.range.lt)}`);
      return { label, value: parts.join(' ') };
    }

    return null;
  }

  private filterKeyToLabel(key: string): string {
    const map: Record<string, string> = {
      'metadata.tipo_documento': 'Tipo',
      'metadata.data_documento': 'Data documento',
      'metadata.data_scadenza': 'Scadenza',
      'metadata.importi.totale': 'Importo',
      'metadata.emittente.ragione_sociale': 'Emittente',
      'metadata.destinatario.ragione_sociale': 'Destinatario',
      'metadata.emittente.partita_iva': 'P.IVA emittente',
      'metadata.numero_documento': 'N. documento',
      'metadata.parole_chiave': 'Parole chiave',
      'db.tipo_documento': 'Tipo (DB)',
      'db.societa': 'Società',
      'db.utente': 'Utente',
    };
    return map[key] || key.split('.').pop() || key;
  }

  private filterValueToDisplay(key: string, val: any): string {
    if (key === 'metadata.tipo_documento') {
      const map: Record<string, string> = {
        fattura: 'Fattura', contratto: 'Contratto', ordine: 'Ordine',
        DDT: 'DDT', nota_credito: 'Nota di credito', preventivo: 'Preventivo',
        bolla: 'Bolla', lettera: 'Lettera', circolare: 'Circolare',
      };
      return map[val] || String(val);
    }
    if (key === 'metadata.importi.totale') {
      return Number(val).toLocaleString('it-IT', { minimumFractionDigits: 2 }) + ' €';
    }
    return String(val);
  }

  private isDateField(key: string): boolean {
    const field = key.split('.').pop() || '';
    return ['data_documento', 'data_scadenza', 'data_inserimento', 'data_riferimento'].includes(field);
  }

  private formatFilterValue(key: string, val: any): string {
    if (this.isDateField(key)) {
      try {
        const d = new Date(val);
        if (!isNaN(d.getTime())) return d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
      } catch { /* fall through */ }
    }
    const field = key.split('.').pop() || '';
    if (field === 'totale' || key.includes('importi')) {
      return Number(val).toLocaleString('it-IT', { minimumFractionDigits: 2 }) + ' €';
    }
    return String(val);
  }

  /**
   * Normalizza il cosine similarity [0.15–0.85] in una scala utente [0–100%].
   * text-embedding-3-large raramente supera 0.85 o scende sotto 0.15.
   */
  private normalizeScore(score: number): number {
    const MIN = 0.15; // score_threshold di Qdrant
    const MAX = 0.80; // massimo realistico per embedding di testo
    const normalized = Math.round(((score - MIN) / (MAX - MIN)) * 100);
    return Math.max(0, Math.min(100, normalized));
  }

  /**
   * Soglie assolute basate sul cosine similarity reale.
   */
  private calcRelevance(score: number): 'alta' | 'media' | 'bassa' {
    if (score >= 0.55) return 'alta';
    if (score >= 0.35) return 'media';
    return 'bassa';
  }

  private formatDisplayDate(r: SearchResult): string {
    const dateStr = r.metadata_ai?.data_documento || r.metadata_db?.data_documento;
    if (!dateStr) return '—';
    try {
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return dateStr;
      return d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
    } catch {
      return dateStr;
    }
  }

  private mapDocType(r: SearchResult): string {
    const tipo = (r.metadata_ai?.tipo_documento || r.metadata_db?.tipo_documento || 'altro').toLowerCase();
    const map: Record<string, string> = {
      fattura: 'Fatture Passive',
      fattura_attiva: 'Fatture Attive',
      contratto: 'Contratti',
      nota_credito: 'Note di Credito',
      ddt: 'DDT',
      ordine: 'Ordini',
      preventivo: 'Preventivi',
    };
    return map[tipo] || tipo.charAt(0).toUpperCase() + tipo.slice(1);
  }

  private mapTypeClass(r: SearchResult): string {
    const tipo = (r.metadata_ai?.tipo_documento || r.metadata_db?.tipo_documento || 'altro').toLowerCase();
    const map: Record<string, string> = {
      fattura: 'tag-fatture-passive',
      fattura_attiva: 'tag-fatture-attive',
      contratto: 'tag-contratti',
      nota_credito: 'tag-note-credito',
      ddt: 'tag-ddt',
    };
    return map[tipo] || 'tag-fatture-passive';
  }
}
