import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('usuarios')
export class Usuario {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  username!: string;

  @Column()
  password!: string;

  @Column()
  nombre!: string;

  @Column({ nullable: true })
  adempiere_user_id!: number;

  @Column("simple-array", { nullable: true })
  rol!: string[];

  @Column({ default: 1 })
  activo!: number;
}