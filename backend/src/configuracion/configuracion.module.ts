import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfiguracionService } from './configuracion.service';
import { ConfiguracionController } from './configuracion.controller';
import { Configuracion } from './entities/configuracion.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Configuracion], 'intranetConnection')],
  controllers: [ConfiguracionController],
  providers: [ConfiguracionService],
  exports: [ConfiguracionService]
})
export class ConfiguracionModule {}
