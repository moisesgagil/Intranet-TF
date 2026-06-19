import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { RhModule } from './rh/rh.module';   //------------------------------ comentarlo si no hay vpn
import { SocialModule } from './social/social.module';
import { ChatModule } from './chat/chat.module';
import { AuthModule } from './auth/auth.module';

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
    
    // Conexión 2: La base de datos de Lirion (ERP)   --------------------------------------comentado mientras no hay vpn
    TypeOrmModule.forRoot({
      name: 'lirionConnection',
      type: 'postgres',
      host: '192.168.3.80',
      port: 5432,
      username: 'adempiere',
      password: 'adempiere',
      database: 'liriontechfoodstest_29122025',
      synchronize: false, // En false para no alterar la DB de Lirion
    }),

    RhModule,  //Comentar esto igual si no hay VPN
    SocialModule,
    ChatModule,
    AuthModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}