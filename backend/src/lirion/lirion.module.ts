import { Module } from '@nestjs/common';
import { LirionService } from './lirion.service';
import { ConfiguracionModule } from '../configuracion/configuracion.module';

@Module({
  imports: [ConfiguracionModule],
  providers: [LirionService],
  exports: [LirionService]
})
export class LirionModule {}
