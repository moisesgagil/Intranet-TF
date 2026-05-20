import { 
  WebSocketGateway, 
  SubscribeMessage, 
  MessageBody, 
  ConnectedSocket, 
  WebSocketServer 
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Mensaje } from './entities/mensaje.entity'; // Importamos tu entidad

@WebSocketGateway({
  cors: {
    origin: '*',
  },
})
export class ChatGateway {
  @WebSocketServer()
  server!: Server;

  private usuariosConectados = new Map<string, string>();

  // 1. INYECTAMOS LA BASE DE DATOS (SQLite) AL CORAZÓN DEL WEBSOCKET
  constructor(
    @InjectRepository(Mensaje, 'intranetConnection')
    private mensajeRepository: Repository<Mensaje>
  ) {}

  handleConnection(client: Socket) {
    console.log(`🔌 Cliente conectado: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    for (const [usuario, socketId] of this.usuariosConectados.entries()) {
      if (socketId === client.id) {
        this.usuariosConectados.delete(usuario);
        console.log(`❌ ${usuario} se ha desconectado.`);
        break;
      }
    }
  }

  getUsuariosEnLinea(): string[] {
    return Array.from(this.usuariosConectados.keys());
  }

  @SubscribeMessage('registrar_usuario')
  handleRegistrarUsuario(
    @MessageBody() datos: { miUsuario: string },
    @ConnectedSocket() client: Socket
  ) {
    this.usuariosConectados.set(datos.miUsuario, client.id);
  }

  // 2. ESCUCHAMOS, GUARDAMOS Y REPARTIMOS
  @SubscribeMessage('enviar_mensaje_privado')
  async handleMensajePrivado( // <-- Ahora es 'async' porque guarda en BD
    @MessageBody() data: { emisor: string; receptor: string; texto: string },
    @ConnectedSocket() client: Socket
  ) {
    console.log(`📩 Procesando mensaje de ${data.emisor} a ${data.receptor}...`);

    // A) GUARDADO OBLIGATORIO EN SQLITE ANTES DE CUALQUIER OTRA COSA
    // Aquí obligamos a que 'texto' calce en tu columna 'contenido'
    const nuevoMsjBD = this.mensajeRepository.create({
      emisor: data.emisor,
      receptor: data.receptor,
      contenido: data.texto,
      fechaEnvio: new Date()
    });
    
    // Esperamos a que la base de datos confirme que se guardó
    await this.mensajeRepository.save(nuevoMsjBD);

    // B) PREPARAMOS LA CAJITA PARA EL WEBSOCKET CON EL DATO YA RESPALDADO
    const mensajeFinal = {
      emisor: data.emisor,
      receptor: data.receptor,
      texto: data.texto,
      fecha: nuevoMsjBD.fechaEnvio
    };

    // C) SE LO MANDAMOS A LA PANTALLA DEL RECEPTOR SI ESTÁ CONECTADO
    const socketReceptorId = this.usuariosConectados.get(data.receptor);
    if (socketReceptorId) {
      this.server.to(socketReceptorId).emit('recibir_mensaje_privado', mensajeFinal);
    }

    // D) LE CONFIRMAMOS A TU PANTALLA QUE TODO SALIÓ BIEN Y SE GUARDÓ
    client.emit('confirmar_mensaje_enviado', mensajeFinal);
  }
}