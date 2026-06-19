import { Component, OnInit, inject } from '@angular/core';
import { Router } from '@angular/router';
import { CommonModule } from '@angular/common';
import { Auth } from '../../services/auth';

@Component({
  selector: 'app-seleccionar-rol',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './seleccionar-rol.html'
})
export class SeleccionarRol implements OnInit {
  roles: string[] = [];
  private router = inject(Router);
  private authService = inject(Auth);

  ngOnInit() {
    const rolesStr = localStorage.getItem('usuario_roles');
    if (rolesStr) {
      try {
        this.roles = JSON.parse(rolesStr);
      } catch (e) {
        console.error('Error parseando roles', e);
      }
    }

    if (!this.roles || this.roles.length === 0) {
      this.router.navigate(['/login']);
    }
  }

  seleccionarRol(rol: string) {
    localStorage.setItem('active_role', rol);
    this.router.navigate(['/inicio']);
  }
}
