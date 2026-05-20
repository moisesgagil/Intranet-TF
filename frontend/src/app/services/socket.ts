import { Injectable } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { Observable } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class SocketService {
  private socket!: Socket;
  // Apuntamos a la URL de tu NestJS local
  private urlBackend = 'http://localhost:3000'; 

  constructor() {
    // Inicializamos la conexión limpia con el backend
    this.socket = io(this.urlBackend, {
      autoConnect: true
    });
  }

  // ACCIÓN 1: Registrar el nombre del usuario en el mapa del Backend
  registrarUsuario(nombreUsuario: string) {
    this.socket.emit('registrar_usuario', { miUsuario: nombreUsuario });
  }

  // ACCIÓN 2: Emitir un mensaje en vivo hacia el servidor
  enviarMensajePrivado(emisor: string, receptor: string, texto: string) {
    this.socket.emit('enviar_mensaje_privado', { emisor, receptor, texto });
  }

  // ACCIÓN 3: Escuchar en tiempo real cuando llega un mensaje de otra persona
  onRecibirMensaje(): Observable<any> {
    return new Observable((subscriber) => {
      this.socket.on('recibir_mensaje_privado', (nuevoMensaje) => {
        subscriber.next(nuevoMensaje);
      });
    });
  }

  // ACCIÓN 4: Escuchar la confirmación de que nuestro propio mensaje se envió
  onConfirmarMensajeEnviado(): Observable<any> {
    return new Observable((subscriber) => {
      this.socket.on('confirmar_mensaje_enviado', (confirmacion) => {
        subscriber.next(confirmacion);
      });
    });
  }
}