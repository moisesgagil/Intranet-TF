import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

@Injectable({
  providedIn: 'root'
})
export class Auth {
  private http = inject(HttpClient);
  
  // Apuntamos al backend de NestJS
  private apiUrl = 'http://localhost:3000/api'; 

  // Envía las credenciales y, si es exitoso, guarda los datos
  login(credenciales: { username: string; password: string }): Observable<any> {
    return this.http.post<any>(`${this.apiUrl}/auth/login`, credenciales).pipe(
      tap(res => {
        // Guardamos TODA la data vital que mandará tu backend híbrido
        localStorage.setItem('token', res.token);
        localStorage.setItem('usuarioNombre', res.nombre);
        localStorage.setItem('usuarioRol', res.rol);
        localStorage.setItem('usuarioId', res.id.toString());
        // Vital para las operaciones de producción:
        localStorage.setItem('usuarioLirionId', res.adempiere_user_id.toString()); 
      })
    );
  }

  // Comprueba si el usuario tiene una sesión activa
  estaAutenticado(): boolean {
    return !!localStorage.getItem('token');
  }

  // Limpia el navegador al salir
  cerrarSesion() {
    localStorage.clear();
  }
}