import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { SelectProComponent } from '../../components/select-pro/select-pro.component';

@Component({
  selector: 'app-configuracion',
  standalone: true,
  imports: [CommonModule, FormsModule, SelectProComponent],
  templateUrl: './configuracion.html'
})
export class Configuracion implements OnInit {
  private http = inject(HttpClient);
  
  configs: { [key: string]: string } = {};
  loading = true;
  saving = false;
  successMessage = '';

  ngOnInit() {
    this.cargarConfiguracion();
  }

  cargarConfiguracion() {
    this.loading = true;
    this.http.get<any[]>('http://localhost:3000/api/configuracion').subscribe({
      next: (data) => {
        data.forEach(item => {
          this.configs[item.clave] = item.valor;
        });
        this.loading = false;
      },
      error: (err) => {
        console.error('Error cargando configuración', err);
        this.loading = false;
      }
    });
  }

  guardar() {
    this.saving = true;
    this.successMessage = '';
    const payload = Object.keys(this.configs).map(key => ({
      clave: key,
      valor: this.configs[key]
    }));

    this.http.post('http://localhost:3000/api/configuracion/batch', payload).subscribe({
      next: () => {
        this.saving = false;
        this.successMessage = 'Configuración guardada exitosamente';
        setTimeout(() => this.successMessage = '', 3000);
      },
      error: (err) => {
        console.error('Error guardando', err);
        this.saving = false;
      }
    });
  }
}
