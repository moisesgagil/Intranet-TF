import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsuariosService } from './usuarios.service';
import { UsuariosController } from './usuarios.controller';
import { Usuario } from '../auth/entities/usuario.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Usuario], 'intranetConnection')],
  controllers: [UsuariosController],
  providers: [UsuariosService],
})
export class UsuariosModule {}
