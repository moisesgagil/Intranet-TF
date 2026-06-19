import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { SelectProComponent } from '../../components/select-pro/select-pro.component';

@Component({
  selector: 'app-usuarios',
  standalone: true,
  imports: [CommonModule, FormsModule, SelectProComponent],
  templateUrl: './usuarios.html'
})
export class Usuarios implements OnInit {
  private http = inject(HttpClient);
  
  usuarios: any[] = [];
  loading = true;

  rolesPermitidos = ['operador', 'admin', 'system'];

  ngOnInit() {
    this.cargarUsuarios();
  }

  cargarUsuarios() {
    this.loading = true;
    this.http.get<any[]>('http://localhost:3000/api/usuarios').subscribe({
      next: (data) => {
        this.usuarios = data;
        this.loading = false;
      },
      error: (err) => {
        console.error('Error cargando usuarios', err);
        this.loading = false;
      }
    });
  }

  cambiarRol(usuario: any, nuevoRol: string) {
    usuario.isSaving = true;
    this.http.put(`http://localhost:3000/api/usuarios/${usuario.id}/rol`, { rol: nuevoRol }).subscribe({
      next: () => {
        usuario.rol = nuevoRol;
        usuario.isSaving = false;
        usuario.showSuccess = true;
        setTimeout(() => usuario.showSuccess = false, 2000);
      },
      error: (err) => {
        console.error('Error cambiando rol', err);
        usuario.isSaving = false;
      }
    });
  }
}
