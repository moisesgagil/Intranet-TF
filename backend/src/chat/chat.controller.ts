import { Controller, Get } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Usuario } from '../auth/entities/usuario.entity';
import { Mensaje } from './entities/mensaje.entity'; // <-- 1. IMPORTAMOS LA ENTIDAD MENSAJE
import { ChatGateway } from './chat.gateway';

@Controller('api/chat')
export class ChatController {
  constructor(
    @InjectRepository(Usuario, 'intranetConnection')
    private usuarioRepository: Repository<Usuario>,
    
    // 2. INYECTAMOS LA TABLA DE MENSAJES PARA PODER LEERLA
    @InjectRepository(Mensaje, 'intranetConnection')
    private mensajeRepository: Repository<Mensaje>,
    
    private chatGateway: ChatGateway
  ) {}

  @Get('usuarios')
  async obtenerUsuariosSincronizados() {
    const usuariosBD = await this.usuarioRepository.find({
      where: { activo: 1 },
      select: ['username', 'nombre', 'rol'] 
    });

    const conectados = this.chatGateway.getUsuariosEnLinea();

    return usuariosBD.map(user => ({
      nombre: user.nombre,
      username: user.username,
      rol: user.rol,
      online: conectados.some(c => c.toLowerCase() === user.nombre.toLowerCase())
    }));
  }

  // =================================================================
  // 3. 🔥 EL ENDPOINT QUE FALTABA: LEER EL HISTORIAL DESDE SQLITE
  // =================================================================
  @Get('historial')
  async obtenerHistorialCompleto() {
    // Buscamos todos los mensajes y los ordenamos del más antiguo al más nuevo
    return await this.mensajeRepository.find({
      order: { fechaEnvio: 'ASC' }
    });
  }
}