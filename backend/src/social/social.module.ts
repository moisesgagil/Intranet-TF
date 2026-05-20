import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Noticia } from './entities/noticia.entity';
import { Reaccion } from './entities/reaccion.entity';
import { Comentario } from './entities/comentario.entity';
import { SocialService } from './social.service';
import { SocialController } from './social.controller';

@Module({
  // Agregar Comentario aquí 👇
  imports: [TypeOrmModule.forFeature([Noticia, Reaccion, Comentario], 'intranetConnection')],
  controllers: [SocialController],
  providers: [SocialService],
})
export class SocialModule {}