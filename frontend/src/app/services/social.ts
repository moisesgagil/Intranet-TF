import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class Social {
  private http = inject(HttpClient);
  private apiUrl = 'http://localhost:3000/api';

  obtenerNoticias(): Observable<any[]> {
    return this.http.get<any[]>(`${this.apiUrl}/noticias`);
  }

  crearNoticia(noticia: any): Observable<any> {
    return this.http.post<any>(`${this.apiUrl}/noticias`, noticia);
  }

  // Enviar un Me Gusta
  reaccionar(noticiaId: number, tipo: string, autor: string): Observable<any> {
    return this.http.post<any>(`${this.apiUrl}/noticias/${noticiaId}/reacciones`, { tipo, autor });
  }

  // Enviar un Comentario
  comentar(noticiaId: number, autor: string, contenido: string): Observable<any> {
    return this.http.post<any>(`${this.apiUrl}/noticias/${noticiaId}/comentarios`, { autor, contenido });
  }

  // Llamada HTTP para borrar
  borrarNoticia(id: number): Observable<any> {
    return this.http.delete(`http://localhost:3000/api/noticias/${id}`);
  }

  editarNoticia(id: number, titulo: string, contenido: string): Observable<any> {
    return this.http.patch(`http://localhost:3000/api/noticias/${id}`, { titulo, contenido });
  }


}