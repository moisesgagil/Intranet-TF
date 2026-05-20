import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { ChatGateway } from './chat.gateway';
import { Mensaje } from './entities/mensaje.entity';
import { Usuario } from '../auth/entities/usuario.entity'; // <-- 1. IMPORTAMOS LA ENTIDAD USUARIO

@Module({
  imports: [
    // 2. AGREGAMOS "Usuario" AL ARREGLO PARA DARLE PERMISO AL CONTROLADOR
    TypeOrmModule.forFeature([Mensaje, Usuario], 'intranetConnection') 
  ],
  controllers: [ChatController],
  providers: [
    ChatService, 
    ChatGateway
  ],
})
export class ChatModule {}