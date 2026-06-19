import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { RhModule } from './rh/rh.module';   //------------------------------ comentarlo si no hay vpn
import { SocialModule } from './social/social.module';
import { ChatModule } from './chat/chat.module';
import { AuthModule } from './auth/auth.module';
import { ConfiguracionModule } from './configuracion/configuracion.module';
import { UsuariosModule } from './usuarios/usuarios.module';
import { LirionModule } from './lirion/lirion.module';

@Module({
  imports: [
    // Conexión 1: Tu base de datos nueva para la Intranet (AHORA CON MYSQL)
    TypeOrmModule.forRoot({
      name: 'intranetConnection', // Nombre clave
      type: 'mysql',
      host: '192.168.3.254',
      port: 3306,
      username: 'sysop',
      password: 'fewlikeme123!',
      database: 'intranet-tf',
      autoLoadEntities: true,
      synchronize: true, // Útil en desarrollo, crea las tablas automático
    }),

    RhModule,  //Comentar esto igual si no hay VPN
    SocialModule,
    ChatModule,
    AuthModule,
    ConfiguracionModule,
    UsuariosModule,
    LirionModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}