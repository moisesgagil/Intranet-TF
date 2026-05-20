import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn } from 'typeorm';

@Entity('mensajes')
export class Mensaje {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  emisor!: string; // El trabajador que envía el mensaje

  @Column({ nullable: true })
  receptor!: string; // A quién va dirigido. Si es nulo, podríamos considerarlo un chat global.

  @Column('text')
  contenido!: string;

  @CreateDateColumn()
  fechaEnvio!: Date;
}