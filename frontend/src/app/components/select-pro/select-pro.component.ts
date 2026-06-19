import { Component, Input, Output, EventEmitter, ElementRef, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-select-pro',
  templateUrl: './select-pro.component.html',
  standalone: true,
  imports: [CommonModule, FormsModule]
})
export class SelectProComponent {
  @Input() label: string = '';
  @Input() placeholder: string = 'Seleccione una opción';
  @Input() options: { id: any, name: string }[] = [];
  @Input() selectedId: any = null;
  @Input() zIndex: number = 50;
  @Input() isCompact: boolean = false;

  @Output() selectionChange = new EventEmitter<any>();

  isOpen = false;
  searchQuery = '';

  constructor(private elementRef: ElementRef) {}

  get selectedName(): string {
    if (this.selectedId === null || this.selectedId === undefined) {
      return this.placeholder;
    }
    const option = this.options.find(o => o.id === this.selectedId);
    return option ? option.name : this.placeholder;
  }

  get filteredOptions() {
    if (!this.searchQuery) return this.options;
    const lowerQuery = this.searchQuery.toLowerCase();
    return this.options.filter(o => o.name.toLowerCase().includes(lowerQuery));
  }

  toggleOpen() {
    this.isOpen = !this.isOpen;
    if (this.isOpen) {
      this.searchQuery = ''; // Reset search on open
    }
  }

  close() {
    this.isOpen = false;
  }

  selectOption(id: any) {
    this.selectedId = id;
    this.selectionChange.emit(id);
    this.close();
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent) {
    if (this.isOpen) {
      const clickedInside = this.elementRef.nativeElement.contains(event.target);
      if (!clickedInside) { 
        this.close(); 
      }
    }
  }
}
