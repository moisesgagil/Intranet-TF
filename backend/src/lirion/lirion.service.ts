import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfiguracionService } from '../configuracion/configuracion.service';
import { Pool } from 'pg';

@Injectable()
export class LirionService implements OnModuleDestroy {
  private pool: Pool | null = null;
  private currentConfigString: string = '';

  constructor(private readonly configuracionService: ConfiguracionService) {}

  private async getActivePool(): Promise<Pool> {
    // Conexión estática: host y base de datos fijos (no cambian en tiempo real)
    const host = '192.168.3.80';
    const database = 'liriontechfoodstest_29122025'; // base de pruebas fija
    const configString = `${host}-${database}`;

    if (!this.pool || this.currentConfigString !== configString) {
      if (this.pool) {
        await this.pool.end();
      }

      this.pool = new Pool({
        user: 'adempiere',
        password: 'adempiere',
        host,
        database,
        port: 5432,
        max: 5,
        idleTimeoutMillis: 3000,
        connectionTimeoutMillis: 2000,
      });

      this.pool.on('error', (err) => {
        console.error('⚠️ Advertencia Lirion Pool:', err.message);
      });

      this.currentConfigString = configString;
      console.log(`🔄 [LirionService] Conexión Postgres establecida a: ${database} en ${host}`);
    }

    return this.pool;
  }

  public async query(sql: string, params?: any[]): Promise<any> {
    const pool = await this.getActivePool();
    const result = await pool.query(sql, params);
    return result.rows;
  }

  public async getApiConfig(): Promise<{ host: string; port: number }> {
    // Host y path permanecen fijos; solo cambian los puertos según el entorno seleccionado.
    const configs = await this.configuracionService.getAll();
    const configMap = configs.reduce((acc, curr) => {
      acc[curr.clave] = curr.valor;
      return acc;
    }, {} as any);

    const isProd = configMap['default_server'] === 'prod' || configMap['default_server'] === 'real';
    const port = isProd ? 8450 : 8452; // 8450 = producción, 8452 = pruebas
    const host = '192.168.3.80';

    return { host, port };
  }

  async onModuleDestroy() {
    if (this.pool) {
      await this.pool.end();
    }
  }
}
