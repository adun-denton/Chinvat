<?php
/**
 * Security primitives shared by Chinvat Bridge abilities. (v0.1.2 hardened)
 *
 * @package ChinvatBridge
 */

declare( strict_types = 1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * True only when the site owner has opted in via wp-config.php AND file
 * editing is not disabled by DISALLOW_FILE_EDIT.
 *
 * @return bool
 */
function chinvat_bridge_writes_enabled(): bool {
	if ( ! CHINVAT_BRIDGE_ENABLE ) {
		return false;
	}
	if ( defined( 'DISALLOW_FILE_EDIT' ) && DISALLOW_FILE_EDIT ) {
		return false;
	}
	return true;
}

/**
 * Returns the immutable core option denylist. This list MUST NOT be filtered away.
 *
 * @return string[]
 */
function chinvat_bridge_core_option_denylist(): array {
	return array(
		'auth_key',
		'auth_salt',
		'logged_in_key',
		'logged_in_salt',
		'nonce_key',
		'nonce_salt',
		'secret',
		'mailserver_pass',
		'mailserver_login',
		'users_can_register',
		'default_role',
		'active_plugins',
		'active_sitewide_plugins',
		'template',
		'stylesheet',
		'siteurl',
		'home',
		'admin_email',
		'cron',
		'wp_user_roles',
	);
}

/**
 * Reject option keys that are on the denylist or match a secret-ish pattern.
 *
 * The core denylist is immutable; a filter can only ADD keys. Keys ending
 * with `_user_roles` (table-prefixed roles) and keys matching a suspicious
 * pattern are also refused.
 *
 * @param string $key Option name.
 * @return true|WP_Error
 */
function chinvat_bridge_guard_option( string $key ) {
	$key = trim( $key );
	if ( '' === $key || ! preg_match( '/^[A-Za-z0-9_\-]+$/', $key ) ) {
		return new WP_Error( 'chinvat_invalid_option', __( 'Invalid option key.', 'chinvat-bridge' ) );
	}

	$core_denied = chinvat_bridge_core_option_denylist();

	/**
	 * Filters ADDITIONAL option keys to deny. Cannot remove the core set.
	 *
	 * @param string[] $extra_denied Extra keys to block.
	 */
	$extra_denied = apply_filters( 'chinvat_bridge_option_extra_denylist', array() );
	$all_denied   = array_merge( $core_denied, (array) $extra_denied );

	if ( in_array( $key, $all_denied, true ) || preg_match( '/_user_roles$/', $key ) ) {
		return new WP_Error( 'chinvat_forbidden_option', __( 'This option is not accessible.', 'chinvat-bridge' ) );
	}

	if ( preg_match( '/(pass|pwd|secret|salt|_key$|token|api[_-]?key)/i', $key ) ) {
		return new WP_Error( 'chinvat_forbidden_option', __( 'This option is not accessible.', 'chinvat-bridge' ) );
	}

	return true;
}

/**
 * Extensions the bridge may write into the theme. The filter may only
 * intersect (narrow) the hard-coded default set, never expand it.
 *
 * @return string[]
 */
function chinvat_bridge_allowed_extensions(): array {
	$defaults = array( 'php', 'css', 'js', 'json', 'html', 'twig', 'txt', 'md' );

	/**
	 * Filters allowed extensions. Result is intersected with the defaults,
	 * so a filter can only remove, never add.
	 *
	 * @param string[] $defaults The default allowed extensions.
	 */
	$filtered = apply_filters( 'chinvat_bridge_allowed_extensions', $defaults );
	$allowed  = array_intersect( (array) $filtered, $defaults );
	return array_values( array_unique( $allowed ) );
}

/**
 * Resolve a caller-supplied relative path to an absolute path proven to sit
 * inside the active (stylesheet) theme directory. Blocks traversal, rejects
 * symlinks, and confines the leaf on writes as well as reads.
 *
 * @param string $rel        Relative path within the theme.
 * @param bool   $must_exist Require the target file to already exist.
 * @return string|WP_Error Confined absolute path on success.
 */
function chinvat_bridge_resolve_theme_path( string $rel, bool $must_exist ) {
	$root = wp_normalize_path( realpath( get_stylesheet_directory() ) );
	if ( ! $root ) {
		return new WP_Error( 'chinvat_no_theme_root', __( 'Could not resolve theme directory.', 'chinvat-bridge' ) );
	}
	$root_slash = $root . '/';

	$rel = ltrim( wp_normalize_path( $rel ), '/' );
	if ( '' === $rel ) {
		return new WP_Error( 'chinvat_invalid_path', __( 'Invalid path.', 'chinvat-bridge' ) );
	}

	// Validate every segment; reject "." and ".." explicitly.
	$segments = explode( '/', $rel );
	foreach ( $segments as $seg ) {
		if ( '' === $seg ) {
			continue;
		}
		if ( '.' === $seg || '..' === $seg || ! preg_match( '/^[A-Za-z0-9._-]+$/', $seg ) ) {
			return new WP_Error( 'chinvat_invalid_path', __( 'Invalid path segment.', 'chinvat-bridge' ) );
		}
	}

	$ext = strtolower( pathinfo( $rel, PATHINFO_EXTENSION ) );
	if ( '' === $ext || ! in_array( $ext, chinvat_bridge_allowed_extensions(), true ) ) {
		return new WP_Error( 'chinvat_bad_extension', __( 'File extension not allowed.', 'chinvat-bridge' ) );
	}

	$candidate = $root . '/' . $rel;

	// Never operate on a symlink (even a broken one).
	if ( is_link( $candidate ) ) {
		return new WP_Error( 'chinvat_path_escape', __( 'Symlinks are not permitted.', 'chinvat-bridge' ) );
	}

	if ( $must_exist ) {
		$real = realpath( $candidate );
		$real = $real ? wp_normalize_path( $real ) : '';
		if ( '' === $real || 0 !== strpos( $real . '/', $root_slash ) ) {
			return new WP_Error( 'chinvat_path_escape', __( 'Path resolves outside the theme directory.', 'chinvat-bridge' ) );
		}
		if ( ! is_file( $candidate ) ) {
			return new WP_Error( 'chinvat_not_found', __( 'File does not exist.', 'chinvat-bridge' ) );
		}
		return $real;
	}

	// Write path: the parent directory must resolve inside the theme root.
	$parent = realpath( dirname( $candidate ) );
	$parent = $parent ? wp_normalize_path( $parent ) : '';
	if ( '' === $parent || 0 !== strpos( $parent . '/', $root_slash ) ) {
		return new WP_Error( 'chinvat_path_escape', __( 'Path resolves outside the theme directory.', 'chinvat-bridge' ) );
	}

	// If the target already exists it must be a regular file inside the root.
	if ( file_exists( $candidate ) ) {
		if ( ! is_file( $candidate ) ) {
			return new WP_Error( 'chinvat_not_regular', __( 'Target is not a regular file.', 'chinvat-bridge' ) );
		}
		$real = realpath( $candidate );
		$real = $real ? wp_normalize_path( $real ) : '';
		if ( '' === $real || 0 !== strpos( $real . '/', $root_slash ) ) {
			return new WP_Error( 'chinvat_path_escape', __( 'Path resolves outside the theme directory.', 'chinvat-bridge' ) );
		}
		return $real;
	}

	return $candidate;
}

/**
 * Atomically write content to a confined path. Refuses symlinks, writes to a
 * temp file in the same directory, then renames over the target. Because
 * rename() replaces the directory entry rather than following it, a symlink
 * swapped in after the confinement check cannot redirect the write (defeats
 * the TOCTOU race).
 *
 * @param string $abs_path Confined absolute destination (from resolve_theme_path).
 * @param string $content  Bytes to write.
 * @return int|WP_Error Bytes written on success.
 */
function chinvat_bridge_atomic_write( string $abs_path, string $content ) {
	$root = wp_normalize_path( realpath( get_stylesheet_directory() ) );
	if ( ! $root ) {
		return new WP_Error( 'chinvat_no_theme_root', __( 'Could not resolve theme directory.', 'chinvat-bridge' ) );
	}
	$root_slash = $root . '/';
	$dir        = dirname( $abs_path );

	if ( is_link( $abs_path ) ) {
		return new WP_Error( 'chinvat_path_escape', __( 'Refusing to write through a symlink.', 'chinvat-bridge' ) );
	}
	if ( file_exists( $abs_path ) ) {
		if ( ! is_file( $abs_path ) ) {
			return new WP_Error( 'chinvat_not_regular', __( 'Target is not a regular file.', 'chinvat-bridge' ) );
		}
		$real = realpath( $abs_path );
		$real = $real ? wp_normalize_path( $real ) : '';
		if ( '' === $real || 0 !== strpos( $real . '/', $root_slash ) ) {
			return new WP_Error( 'chinvat_path_escape', __( 'Target resolves outside the theme directory.', 'chinvat-bridge' ) );
		}
	}
	$parent = realpath( $dir );
	$parent = $parent ? wp_normalize_path( $parent ) : '';
	if ( '' === $parent || 0 !== strpos( $parent . '/', $root_slash ) ) {
		return new WP_Error( 'chinvat_path_escape', __( 'Parent resolves outside the theme directory.', 'chinvat-bridge' ) );
	}

	$tmp = tempnam( $dir, 'chinvat' );
	if ( false === $tmp ) {
		return new WP_Error( 'chinvat_no_tmp', __( 'Could not create temp file.', 'chinvat-bridge' ) );
	}
	$bytes = file_put_contents( $tmp, $content, LOCK_EX );
	if ( false === $bytes ) {
		@unlink( $tmp );
		return new WP_Error( 'chinvat_write_failed', __( 'Write failed.', 'chinvat-bridge' ) );
	}
	if ( file_exists( $abs_path ) ) {
		$perms = @fileperms( $abs_path );
		if ( $perms ) {
			@chmod( $tmp, $perms & 0777 );
		}
	} else {
		@chmod( $tmp, 0644 );
	}
	if ( ! @rename( $tmp, $abs_path ) ) {
		@unlink( $tmp );
		return new WP_Error( 'chinvat_rename_failed', __( 'Atomic rename failed.', 'chinvat-bridge' ) );
	}
	return (int) $bytes;
}

/**
 * Lint PHP source via `php -l` on a temp file before it is committed. Returns
 * true for non-PHP files or fails closed when the CLI binary is unavailable.
 * NOTE: lint prevents *broken* PHP, not *malicious* PHP; it is not a security
 * boundary.
 *
 * @param string $abs_path Destination path (used to detect extension).
 * @param string $content  Proposed file content.
 * @return true|WP_Error
 */
function chinvat_bridge_php_lint( string $abs_path, string $content ) {
	if ( 'php' !== strtolower( pathinfo( $abs_path, PATHINFO_EXTENSION ) ) ) {
		return true;
	}
	if ( ! function_exists( 'proc_open' ) ) {
		return new WP_Error( 'chinvat_no_lint', __( 'Cannot lint PHP (proc_open disabled); refusing write.', 'chinvat-bridge' ) );
	}
	$tmp = wp_tempnam( 'chinvat-lint' );
	if ( ! $tmp ) {
		return new WP_Error( 'chinvat_no_tmp', __( 'Could not create temp file for lint.', 'chinvat-bridge' ) );
	}
	file_put_contents( $tmp, $content );
	$php  = defined( 'PHP_BINARY' ) && PHP_BINARY ? PHP_BINARY : 'php';
	$desc = array(
		1 => array( 'pipe', 'w' ),
		2 => array( 'pipe', 'w' ),
	);
	$proc = proc_open( escapeshellarg( $php ) . ' -l ' . escapeshellarg( $tmp ), $desc, $pipes );
	$out  = '';
	if ( is_resource( $proc ) ) {
		$out = stream_get_contents( $pipes[1] ) . stream_get_contents( $pipes[2] );
		fclose( $pipes[1] );
		fclose( $pipes[2] );
		$code = proc_close( $proc );
	} else {
		$code = 1;
	}
	@unlink( $tmp );
	if ( 0 !== $code ) {
		return new WP_Error( 'chinvat_lint_failed', __( 'PHP lint failed; write aborted.', 'chinvat-bridge' ), array( 'detail' => trim( $out ) ) );
	}
	return true;
}

/**
 * Back up an existing file to a per-theme directory OUTSIDE the theme (under
 * wp-content), with an index.php and .htaccess deny, refusing symlinked
 * sources and using a collision-proof random suffix.
 *
 * @param string $abs_path Absolute path of the file about to be overwritten.
 * @return string|WP_Error Backup path, or '' if there was no prior file.
 */
function chinvat_bridge_backup( string $abs_path ) {
	if ( ! is_file( $abs_path ) || is_link( $abs_path ) ) {
		return '';
	}
	$root = wp_normalize_path( realpath( get_stylesheet_directory() ) );
	$slug = $root ? substr( hash( 'sha256', $root ), 0, 12 ) : 'default';
	$dir  = trailingslashit( WP_CONTENT_DIR ) . 'chinvat-bak/' . $slug;
	if ( ! wp_mkdir_p( $dir ) ) {
		return new WP_Error( 'chinvat_backup_dir', __( 'Could not create backup directory.', 'chinvat-bridge' ) );
	}
	if ( ! file_exists( $dir . '/index.php' ) ) {
		@file_put_contents( $dir . '/index.php', "<?php // Silence is golden.\n" );
	}
	if ( ! file_exists( dirname( $dir ) . '/.htaccess' ) ) {
		@file_put_contents( dirname( $dir ) . '/.htaccess', "Require all denied\nDeny from all\n" );
	}
	try {
		$rand = bin2hex( random_bytes( 4 ) );
	} catch ( \Exception $e ) {
		$rand = (string) wp_rand( 100000, 999999 );
	}
	$dest = $dir . '/' . basename( $abs_path ) . '.' . gmdate( 'Ymd-His' ) . '.' . $rand;
	if ( ! copy( $abs_path, $dest ) ) {
		return new WP_Error( 'chinvat_backup_copy', __( 'Could not back up existing file.', 'chinvat-bridge' ) );
	}
	return $dest;
}
