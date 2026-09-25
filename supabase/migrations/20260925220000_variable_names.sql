-- More names that change how a program starts are refused as shared
-- variables (`reliquary run` puts every variable into a process):
-- - Windows: COMSPEC and PATHEXT choose how commands and .cmd shims start;
--   SYSTEMROOT, WINDIR and PSMODULEPATH steer system and PowerShell lookups.
-- - Trust: NODE_EXTRA_CA_CERTS, SSL_CERT_FILE and SSL_CERT_DIR could make a
--   process trust an attacker's certificate authority.
-- - npm: any NPM_CONFIG_* (e.g. npm_config_script_shell) can change what npm
--   runs.
-- Existing variables with these names stay readable but can't be set again.

create or replace function private.valid_variable_name(p_name text) returns text
language plpgsql immutable set search_path = '' as $$
begin
  if p_name is null or p_name !~ '^[A-Za-z_][A-Za-z0-9_]{0,127}$' then
    raise exception 'a variable name is letters, digits and underscores, not starting with a digit, up to 128 characters'
      using errcode = '22023';
  end if;
  if upper(p_name) ~ '^(LD_|DYLD_|BASH_FUNC_|GIT_CONFIG_|NPM_CONFIG_)' or upper(p_name) in (
       'PATH', 'HOME', 'SHELL', 'USER', 'IFS', 'ENV', 'BASH_ENV', 'PS4', 'PROMPT_COMMAND', 'SHELLOPTS',
       'BASHOPTS', 'CDPATH', 'NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH', 'PYTHONSTARTUP', 'PYTHONHOME',
       'PERL5OPT', 'PERL5LIB', 'PERLLIB', 'RUBYOPT', 'RUBYLIB', 'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS',
       'JDK_JAVA_OPTIONS', 'CLASSPATH', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_EXEC_PATH', 'GIT_ASKPASS',
       'SSH_ASKPASS', 'EDITOR', 'VISUAL', 'PAGER', 'TMPDIR',
       'COMSPEC', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'PSMODULEPATH',
       'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR') then
    raise exception '% changes how programs start, so it can''t be a shared variable', p_name
      using errcode = '22023';
  end if;
  return p_name;
end $$;
