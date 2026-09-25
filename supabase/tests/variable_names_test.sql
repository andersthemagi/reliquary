-- Names that change how a program starts can't be shared variables
-- (20260925220000_variable_names.sql): Windows start-up, trust stores, npm config.

select t.owner_error('variable names: COMSPEC is refused', $q$select private.valid_variable_name('COMSPEC')$q$);
select t.owner_error('variable names: ComSpec is refused', $q$select private.valid_variable_name('ComSpec')$q$);
select t.owner_error('variable names: PATHEXT is refused', $q$select private.valid_variable_name('PATHEXT')$q$);
select t.owner_error('variable names: SYSTEMROOT is refused', $q$select private.valid_variable_name('SYSTEMROOT')$q$);
select t.owner_error('variable names: WINDIR is refused', $q$select private.valid_variable_name('WINDIR')$q$);
select t.owner_error('variable names: PSModulePath is refused', $q$select private.valid_variable_name('PSModulePath')$q$);
select t.owner_error('variable names: NODE_EXTRA_CA_CERTS is refused', $q$select private.valid_variable_name('NODE_EXTRA_CA_CERTS')$q$);
select t.owner_error('variable names: SSL_CERT_FILE is refused', $q$select private.valid_variable_name('SSL_CERT_FILE')$q$);
select t.owner_error('variable names: SSL_CERT_DIR is refused', $q$select private.valid_variable_name('SSL_CERT_DIR')$q$);
select t.owner_error('variable names: npm_config_script_shell is refused', $q$select private.valid_variable_name('npm_config_script_shell')$q$);
select t.owner_error('variable names: NPM_CONFIG_PREFIX is refused', $q$select private.valid_variable_name('NPM_CONFIG_PREFIX')$q$);
select t.expect('variable names: ordinary names still pass', (select private.valid_variable_name('NPM_TOKEN') || ',' || private.valid_variable_name('SSL_ENABLED') || ',' || private.valid_variable_name('DATABASE_URL')), 'NPM_TOKEN,SSL_ENABLED,DATABASE_URL');
