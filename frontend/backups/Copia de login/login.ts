import { Component, ChangeDetectorRef, OnInit } from '@angular/core';
import { Router, ActivatedRoute } from '@angular/router';
import { AuthService } from '../../service/auth';

@Component({
  selector: 'app-login',
  templateUrl: './login.html',
  standalone: false
})
export class Login implements OnInit {
  loginData: any = {
    username: '',
    password: '',
    clientId: null,
    roleId: null,
    organizationId: null,
    warehouseId: null
  };

  showPassword = false;
  errorMessage = '';
  loading = false;
  serverType = 'test';
  showServerMenu = false;

  rememberMe = false;
  rememberPreferences = false;
  savedPrefs: any = null;

  step = 1;
  rawToken = '';
  clients: any[] = [];
  availablePmsRoles: string[] = [];
  roles: any[] = [];
  organizations: any[] = [];
  warehouses: any[] = [];
  isAutoResolving = true;
  appConfig: any = { allow_server_change: 'true', default_server: 'test' };

  constructor(
    private authService: AuthService,
    private router: Router,
    private route: ActivatedRoute,
    private cd: ChangeDetectorRef
  ) { }

  ngOnInit() {
    this.route.queryParams.subscribe(params => {
      if (params['cambiarRol'] === 'true') {
        const rolesStr = localStorage.getItem('roles_pms');
        if (rolesStr) {
          try {
            this.availablePmsRoles = JSON.parse(rolesStr);
            this.step = 3;
            this.loginData.username = localStorage.getItem('nombre') || '';
            this.cd.detectChanges();
            return;
          } catch (e) {}
        }
      }
      this.initNormalFlow();
    });
  }

  initNormalFlow() {
    this.authService.getSystemConfig().subscribe({
      next: (config) => {
        this.appConfig = config;
        this.serverType = this.appConfig.default_server || 'test';
        this.cd.detectChanges();
      }
    });

    const savedUser = localStorage.getItem('techfoods_user');
    const savedServer = localStorage.getItem('techfoods_server_remembered');

    if (savedServer) {
        this.serverType = savedServer;
    }

    if (savedUser) {
      this.loginData.username = savedUser;
      this.rememberMe = true;
    }

    const savedPrefsStr = localStorage.getItem('techfoods_prefs');
    if (savedPrefsStr) {
      try {
        this.savedPrefs = JSON.parse(savedPrefsStr);
        this.rememberPreferences = true;
      } catch (e) { }
    }
  }

  onLogin() {
    if (this.step === 1) {
      this.onLoginStep1();
    } else {
      this.onLoginFinal();
    }
  }

  onLoginStep1() {
    if (!this.loginData.username || !this.loginData.password) {
      this.errorMessage = 'Por favor, completa todos los campos.';
      return;
    }

    this.loading = true;
    this.errorMessage = '';
    this.isAutoResolving = true;

    if (this.rememberMe) {
      localStorage.setItem('techfoods_user', this.loginData.username);
      localStorage.setItem('techfoods_server_remembered', this.serverType);
    } else {
      localStorage.removeItem('techfoods_user');
      localStorage.removeItem('techfoods_server_remembered');
    }

    this.authService.getLoginInfo(this.loginData, this.serverType).subscribe({
      next: (res) => {
        if (res.clients && res.clients.length > 0) {
          this.clients = res.clients;
          this.rawToken = res.rawToken ? 'Bearer ' + res.rawToken : '';
          
          if (this.savedPrefs && this.savedPrefs.clientId !== null && this.clients.find(c => c.id == this.savedPrefs.clientId)) {
            this.loginData.clientId = this.savedPrefs.clientId;
          } else if (this.clients.length > 0) {
            this.loginData.clientId = this.clients[0].id;
          }

          if (this.loginData.clientId !== null && (this.clients.length > 0 || this.savedPrefs?.clientId !== null)) {
            this.onClientChange(); 
          } else {
            this.isAutoResolving = false;
            this.step = 2;
            this.loading = false;
          }
        } else {
          this.onLoginFinal();
        }
        this.cd.detectChanges();
      },
      error: (err) => {
        this.errorMessage = err.error?.error || 'Usuario o contraseña incorrectos.';
        this.loading = false;
        this.cd.detectChanges();
      }
    });
  }

  onClientChange() {
    if (!this.loginData.clientId) return;
    this.loginData.roleId = null;
    this.roles = [];
    this.organizations = [];
    this.warehouses = [];
    
    this.authService.getRoles(this.loginData.clientId, this.rawToken, this.serverType).subscribe({
      next: (roles) => {
        this.roles = roles;
        if (this.roles.length > 0) {
          if (this.savedPrefs && this.savedPrefs.roleId !== null && this.roles.find(r => r.id == this.savedPrefs.roleId)) {
            this.loginData.roleId = this.savedPrefs.roleId;
          } else if (this.roles.length > 0) {
            this.loginData.roleId = this.roles[0].id;
          }

          if (this.loginData.roleId !== null && (this.roles.length > 0 || this.savedPrefs?.roleId !== null)) {
             this.onRoleChange();
          } else {
             this.isAutoResolving = false;
             this.step = 2;
             this.loading = false;
          }
        } else {
          this.isAutoResolving = false;
          this.step = 2;
          this.loading = false;
        }
        this.cd.detectChanges();
      }
    });
  }

  onRoleChange() {
    if (!this.loginData.roleId) return;
    this.loginData.organizationId = null;
    this.organizations = [];
    this.warehouses = [];
    
    this.authService.getOrganizations(this.loginData.clientId, this.loginData.roleId, this.rawToken, this.serverType).subscribe({
      next: (orgs) => {
        this.organizations = orgs;
        if (this.organizations.length > 0) {
          if (this.savedPrefs && this.savedPrefs.organizationId !== null && this.organizations.find(o => o.id == this.savedPrefs.organizationId)) {
            this.loginData.organizationId = this.savedPrefs.organizationId;
          } else if (this.organizations.length > 0) {
            let defaultOrg = this.organizations.find(o => o.name && o.name.toLowerCase().includes('techfoods'));
            if (!defaultOrg) {
              defaultOrg = this.organizations.find(o => o.name && o.name !== '*');
            }
            if (!defaultOrg) {
              defaultOrg = this.organizations[0];
            }
            this.loginData.organizationId = defaultOrg.id;
          }
          
          if (this.loginData.organizationId !== null && (this.organizations.length > 0 || this.savedPrefs?.organizationId !== null)) {
            this.onOrgChange();
          } else {
            this.isAutoResolving = false;
            this.step = 2;
            this.loading = false;
          }
        } else if (this.organizations.length === 0) {
           this.loginData.organizationId = 0;
           this.onOrgChange();
        } else {
            this.isAutoResolving = false;
            this.step = 2;
            this.loading = false;
        }
        this.cd.detectChanges();
      }
    });
  }

  onOrgChange() {
    if (this.loginData.organizationId === null) return;
    this.loginData.warehouseId = null;
    this.warehouses = [];
    
    this.authService.getWarehouses(this.loginData.clientId, this.loginData.roleId, this.loginData.organizationId, this.rawToken, this.serverType).subscribe({
      next: (warehouses) => {
        this.warehouses = warehouses;
        if (this.warehouses.length > 0) {
          if (this.savedPrefs && this.savedPrefs.warehouseId !== null && this.warehouses.find(w => w.id == this.savedPrefs.warehouseId)) {
            this.loginData.warehouseId = this.savedPrefs.warehouseId;
          } else if (this.warehouses.length > 0) {
            let defaultWh = this.warehouses.find(w => w.name && w.name.toLowerCase().includes('bodega principal'));
            if (!defaultWh) {
              defaultWh = this.warehouses[0];
            }
            this.loginData.warehouseId = defaultWh.id;
          }

          if (this.loginData.warehouseId !== null && (this.warehouses.length > 0 || this.savedPrefs?.warehouseId !== null)) {
            this.isAutoResolving = false;
            this.step = 2;
            this.loading = false;
          } else {
            this.isAutoResolving = false;
            this.step = 2;
            this.loading = false;
          }
        } else if (this.warehouses.length === 0) {
           this.loginData.warehouseId = 0;
           this.isAutoResolving = false;
           this.step = 2;
           this.loading = false;
        } else {
            this.isAutoResolving = false;
            this.step = 2;
            this.loading = false;
        }
        this.cd.detectChanges();
      }
    });
  }

  onLoginFinal() {
    this.loading = true;
    this.errorMessage = '';

    this.authService.login(this.loginData, this.serverType).subscribe({
      next: (res) => {
        this.loading = false;
        this.cd.detectChanges();

        if (this.loginData.roleId) {
          localStorage.setItem('current_role_id', this.loginData.roleId.toString());
        }

        // Siempre guardamos el servidor activo para mostrarlo en la UI
        localStorage.setItem('techfoods_server_active', this.serverType);

        if (this.rememberMe) {
          localStorage.setItem('techfoods_user', this.loginData.username);
          localStorage.setItem('techfoods_server_remembered', this.serverType);
        } else {
          localStorage.removeItem('techfoods_user');
          localStorage.removeItem('techfoods_server_remembered');
        }

        if (this.rememberPreferences) {
          const prefs = {
            clientId: this.loginData.clientId,
            roleId: this.loginData.roleId,
            organizationId: this.loginData.organizationId,
            warehouseId: this.loginData.warehouseId
          };
          localStorage.setItem('techfoods_prefs', JSON.stringify(prefs));
        } else {
          localStorage.removeItem('techfoods_prefs');
        }

        if (res.roles_pms && res.roles_pms.length > 1) {
          this.availablePmsRoles = res.roles_pms;
          this.step = 3;
        } else {
          const rol = res.roles_pms?.length === 1 ? res.roles_pms[0].toLowerCase() : (res.rol?.toLowerCase() || 'operador');
          this.seleccionarRolPms(rol);
        }
      },
      error: (err) => {
        this.errorMessage = err.error?.error || 'Error al validar roles/sesión.';
        this.loading = false;
        this.cd.detectChanges();
        console.error('Login Error:', err);
      }
    });
  }

  togglePassword() {
    this.showPassword = !this.showPassword;
  }

  seleccionarServidor(tipo: string) {
    this.serverType = tipo;
    this.showServerMenu = false;
  }

  seleccionarCliente(clientId: number) {
    this.loginData.clientId = clientId;
    this.isAutoResolving = false;
    this.onClientChange();
  }

  seleccionarRol(roleId: number) {
    this.loginData.roleId = roleId;
    this.isAutoResolving = false;
    this.onRoleChange();
  }

  seleccionarOrg(orgId: number) {
    this.loginData.organizationId = orgId;
    this.isAutoResolving = false;
    this.onOrgChange();
  }

  seleccionarAlmacen(warehouseId: number) {
    this.loginData.warehouseId = warehouseId;
  }

  seleccionarRolPms(rol: string) {
    const r = rol.toLowerCase();
    localStorage.setItem('rol', r);

    if (r === 'admin' || r === 'system') {
      this.router.navigate(['/dashboard']);
    }
    else if (r === 'planificacion') {
      this.router.navigate(['/planificacion']);
    }
    else if (r === 'supervisor' || r === 'calidad') {
      this.router.navigate(['/gestion']);
    }
    else {
      this.router.navigate(['/formulario']);
    }
  }
}