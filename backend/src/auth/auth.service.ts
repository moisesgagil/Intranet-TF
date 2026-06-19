import { Injectable, UnauthorizedException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { Usuario } from './entities/usuario.entity';
import * as bcrypt from 'bcryptjs';
import * as https from 'https';
import { LirionService } from '../lirion/lirion.service';

@Injectable()
export class AuthService implements OnModuleInit {
  constructor(
    @InjectRepository(Usuario, 'intranetConnection')
    private usuarioRepository: Repository<Usuario>,
    
    private lirionService: LirionService,
    
    private jwtService: JwtService
  ) {}

  async onModuleInit() {
    const adminExiste = await this.usuarioRepository.findOne({ where: { username: 'sysop' }});
    if (!adminExiste) {
      const nuevoUser = this.usuarioRepository.create({
        username: 'sysop',
        password: bcrypt.hashSync('fewlikeme123!', 10),
        nombre: 'System Operator',
        rol: ['system'],
        adempiere_user_id: 0,
        activo: 1
      });
      await this.usuarioRepository.save(nuevoUser);
      console.log('✅ Usuario local sysop creado en SQLite');
    }
  }

  async login(username: string, passwordString: string) {
    let isValidInLirion = false;

    // 1. PASO MANDATORIO: VALIDACIÓN CONTRA LA API DE LIRION (LDAP)
    const config = await this.lirionService.getApiConfig();
    try {
      const data = JSON.stringify({ userName: username, password: passwordString });
      
      const options = {
        hostname: config.host,
        port: config.port,
        path: '/api/v1/auth/tokens',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data)
        },
        rejectUnauthorized: false 
      };

      isValidInLirion = await new Promise((resolve) => {
        const reqApi = https.request(options, (resApi) => {
          resApi.on('data', () => {}); 
          resApi.on('end', () => {
            // Capturamos el código de estado de forma segura, si no existe usamos 0
            const statusCode = resApi.statusCode ?? 0;
            resolve(statusCode >= 200 && statusCode < 300);
          });
        });
        
        reqApi.on('error', (e) => {
          console.error("⚠️ API Lirion inalcanzable en NestJS:", e.message);
          resolve(false);
        });
        
        reqApi.write(data);
        reqApi.end();
      });
    } catch (e) {
      console.error("Error en la llamada HTTPS a Lirion:", e);
      isValidInLirion = false;
    }

    let localUser: any = null;

    // 2. SI LIRION DEVOLVIÓ QUE ES VÁLIDO, SINCRO LOCAL
    if (isValidInLirion) {
      const lirionQuery = `
        SELECT ad_user_id, value, name, title, description, email, ldapuser
        FROM adempiere.ad_user 
        WHERE (LOWER(ldapuser) = LOWER($1) OR LOWER(value) = LOWER($1) OR LOWER(name) = LOWER($1) OR LOWER(email) = LOWER($1)) 
          AND isactive = 'Y'
        LIMIT 1
      `;
      
      const lirionRes = await this.lirionService.query(lirionQuery, [username]);

      if (lirionRes.length > 0) {
        const lirionUser = lirionRes[0];

        // Lógica de roles idéntica a tu index.js
        let rolAsignado = 'usuario'; 
        const pistasRol = ((lirionUser.title || '') + ' ' + (lirionUser.description || '')).toLowerCase();
        if (pistasRol.includes('admin')) rolAsignado = 'admin';
        else if (pistasRol.includes('system') || pistasRol.includes('sist')) rolAsignado = 'system';

        // Buscamos si existe en SQLite local
        localUser = await this.usuarioRepository.createQueryBuilder("usuario")
          .where("LOWER(usuario.username) = LOWER(:username)", { username })
          .getOne();

        if (!localUser) {
          // Si no existe, lo insertamos automático en SQLite
          const nuevoLocal = this.usuarioRepository.create({
            username: username,
            password: bcrypt.hashSync(passwordString, 10),
            nombre: lirionUser.name,
            email: lirionUser.email || `${username}@techfoods.cl`,
            adempiere_user_id: lirionUser.ad_user_id,
            rol: [rolAsignado],
            activo: 1
          });
          localUser = await this.usuarioRepository.save(nuevoLocal);
        } else {
          // Si existe, actualizamos credenciales e info de Lirion
          localUser.adempiere_user_id = lirionUser.ad_user_id;
          localUser.password = bcrypt.hashSync(passwordString, 10);
          localUser.nombre = lirionUser.name;
          if (lirionUser.email) {
            localUser.email = lirionUser.email;
          }
          await this.usuarioRepository.save(localUser);
        }
      } else {
        throw new UnauthorizedException('Credenciales correctas, pero usuario inactivo en BD Lirion');
      }

    } else {
      // 3. FALLBACK COMPLETO: SI LA API FALLÓ, BUSCAMOS EN SQLITE DIRECTO
      localUser = await this.usuarioRepository.createQueryBuilder("usuario")
        .where("LOWER(usuario.username) = LOWER(:username)", { username })
        .andWhere("usuario.activo = 1")
        .getOne();
        
      if (!localUser) {
        throw new UnauthorizedException('Usuario no encontrado o contraseña incorrecta');
      }

      const passwordMatch = (passwordString === localUser.password) || bcrypt.compareSync(passwordString, localUser.password);
      if (!passwordMatch) {
        throw new UnauthorizedException('Contraseña incorrecta');
      }
    }

    // 4. GENERACIÓN DE TOKEN PARA ENTRAR A LA INTRANET
    const payload = { 
      id: localUser.id, 
      rol: localUser.rol, 
      nombre: localUser.nombre, 
      adempiere_user_id: localUser.adempiere_user_id 
    };

    const token = this.jwtService.sign(payload);

    return {
      token,
      rol: localUser.rol,
      nombre: localUser.nombre,
      id: localUser.id,
      adempiere_user_id: localUser.adempiere_user_id
    };
  }
}