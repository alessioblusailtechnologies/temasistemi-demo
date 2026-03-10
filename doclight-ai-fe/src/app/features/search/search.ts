import { Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { SearchService, SearchResult, SearchResponse, AppliedFilter } from '../../services/search.service';

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
  semanticQuery = '';
  appliedFilters: AppliedFilter[] = [];
  elapsedMs = 0;
  selectedDoc: DisplayResult | null = null;

  suggestions = [
    { label: 'Fattura ristorante', query: 'Fattura del ristorante' },
    { label: 'Fattura energia elettrica', query: 'Fattura energia elettrica luce' },
    { label: 'Specifiche tecniche cantiere', query: 'Specifiche tecniche cantiere' },
    { label: 'Ordine di lavoro', query: 'Ordine di lavoro intervento tecnico' },
    { label: 'Disdetta contratto', query: 'Disdetta contratto fornitura' },
    { label: 'Contratto lavoro dipendente', query: 'Contratto lavoro dipendente' },
    { label: 'Bolla entrata', query: 'Bolla di entrata merce' },
    { label: 'Catalogo cancelleria', query: 'Catalogo cancelleria ufficio' },
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
    this.appliedFilters = [];
    this.showRelevanceColumn = false;

    this.searchService.search({ query: q, top_k: 20 }).subscribe({
      next: (resp: SearchResponse) => {
        this.loading = false;
        this.semanticQuery = resp.semantic_query;
        this.appliedFilters = resp.filters || [];
        this.elapsedMs = resp.elapsed_ms;

        this.results = resp.results.map(r => ({
          ...r,
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

  openDetail(doc: DisplayResult): void {
    this.selectedDoc = doc;
  }

  closeDetail(): void {
    this.selectedDoc = null;
  }

  getDownloadUrl(nomeFile: string): string {
    return `/api/document/${encodeURIComponent(nomeFile)}/download`;
  }

  formatChunkSimilarity(similarity: number): string {
    return (similarity * 100).toFixed(1) + '%';
  }

  formatFileSize(bytes: number | undefined): string {
    if (!bytes) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

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
    const tipoAI = r.metadata_ai?.tipo_documento;
    const tipoDB = r.metadata_db?.tipo_documento;
    const tipo = (tipoAI || tipoDB || 'altro').toLowerCase();
    const map: Record<string, string> = {
      fattura: 'Fattura',
      fattura_attiva: 'Fattura Attiva',
      contratto: 'Contratto',
      nota_credito: 'Nota di Credito',
      ddt: 'DDT',
      ordine: 'Ordine',
      preventivo: 'Preventivo',
      normativa: 'Normativa',
      rapporto_intervento: 'Rapporto Intervento',
      documento_tecnico: 'Doc. Tecnico',
      modello: 'Modello',
      altro: 'Altro',
    };
    if (!tipoAI && tipoDB) {
      return tipoDB;
    }
    return map[tipo] || tipo.charAt(0).toUpperCase() + tipo.slice(1).replace(/_/g, ' ');
  }

  private mapTypeClass(r: SearchResult): string {
    const tipo = (r.metadata_ai?.tipo_documento || r.metadata_db?.tipo_documento || 'altro').toLowerCase();
    const map: Record<string, string> = {
      fattura: 'tag-fatture-passive',
      fattura_attiva: 'tag-fatture-attive',
      contratto: 'tag-contratti',
      nota_credito: 'tag-note-credito',
      ddt: 'tag-ddt',
      normativa: 'tag-normativa',
      rapporto_intervento: 'tag-doc-tecnico',
      documento_tecnico: 'tag-doc-tecnico',
      modello: 'tag-doc-tecnico',
    };
    return map[tipo] || 'tag-altro';
  }
}
