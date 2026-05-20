import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class Chat {
  private http = inject(HttpClient);

  obtenerHistorial(): Observable<any[]> {
    // ESTA ES LA RUTA QUE AHORA SÍ LEERÁ TU TABLA DE SQLITE
    return this.http.get<any[]>('http://localhost:3000/api/chat/historial');
  }

  obtenerUsuarios(): Observable<any[]> {
    return this.http.get<any[]>('http://localhost:3000/api/chat/usuarios');
  }

  enviarMensaje(emisor: string, receptor: string, contenido: string): Observable<any> {
    // (Opcional) Si ya no usas este endpoint HTTP porque el WebSocket guarda, 
    // puedes dejarlo así o retornar un observable vacío.
    return this.http.post('http://localhost:3000/api/chat/enviar', { emisor, receptor, contenido });
  }
}