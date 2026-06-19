import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';

@Component({
  selector: 'app-usuarios',
  standalone: true,
  imports: [CommonModule, FormsModule],
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
    this.http.get<any[]>('http://localhost:3000/usuarios').subscribe({
      next: (data) => {
        // Aseguramos que rol siempre sea un array
        this.usuarios = data.map(u => ({
          ...u,
          rol: Array.isArray(u.rol) ? u.rol : (typeof u.rol === 'string' ? u.rol.split(',').map((r: string)=>r.trim()) : ['operador'])
        }));
        this.loading = false;
      },
      error: (err) => {
        console.error('Error cargando usuarios', err);
        this.loading = false;
      }
    });
  }

  tieneRol(usuario: any, rol: string): boolean {
    return Array.isArray(usuario.rol) && usuario.rol.includes(rol);
  }

  toggleRol(usuario: any, rol: string) {
    if (usuario.isSaving) return;
    usuario.isSaving = true;

    let rolesActuales = [...usuario.rol];
    if (rolesActuales.includes(rol)) {
      rolesActuales = rolesActuales.filter(r => r !== rol);
    } else {
      rolesActuales.push(rol);
    }

    if (rolesActuales.length === 0) {
      rolesActuales = ['operador']; // Un usuario siempre debe tener al menos el rol operador
    }

    this.http.put(`http://localhost:3000/usuarios/${usuario.id}/rol`, { rol: rolesActuales }).subscribe({
      next: () => {
        usuario.rol = rolesActuales;
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

  toggleActivo(usuario: any, isChecked: boolean) {
    usuario.isSavingActivo = true;
    const nuevoActivo = isChecked ? 1 : 0;
    this.http.put(`http://localhost:3000/usuarios/${usuario.id}/activo`, { activo: nuevoActivo }).subscribe({
      next: () => {
        usuario.activo = nuevoActivo;
        usuario.isSavingActivo = false;
      },
      error: (err) => {
        console.error('Error cambiando estado activo', err);
        usuario.isSavingActivo = false;
      }
    });
  }
}
