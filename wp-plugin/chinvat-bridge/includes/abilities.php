<?php
/**
 * Ability registrations for Chinvat WP Bridge. (v0.1.2)
 *
 * Each capability is a WordPress Ability with a JSON Schema, a per-operation
 * permission_callback, and readonly/destructive/idempotent annotations that
 * the MCP Adapter maps to protocol risk hints.
 *
 * @package ChinvatBridge
 */

declare( strict_types = 1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Register ability categories (required before abilities that reference them).
 */
function chinvat_bridge_register_categories(): void {
	if ( ! function_exists( 'wp_register_ability_category' ) ) {
		return;
	}
	$cats = array(
		'chinvat-options' => __( 'Options', 'chinvat-bridge' ),
		'chinvat-theme'   => __( 'Theme File I/O', 'chinvat-bridge' ),
		'chinvat-seo'     => __( 'SEO (RankMath)', 'chinvat-bridge' ),
		'chinvat-plugins' => __( 'Plugin Management', 'chinvat-bridge' ),
	);
	foreach ( $cats as $slug => $label ) {
		wp_register_ability_category( $slug, array( 'label' => $label, 'description' => $label ) );
	}
}

/**
 * Shared permission helper: capability + optional write gate.
 *
 * @param string $cap      Required capability.
 * @param bool   $is_write Whether this is a write/dangerous op.
 * @return true|WP_Error
 */
function chinvat_bridge_permit( string $cap, bool $is_write ) {
	if ( ! current_user_can( $cap ) ) {
		return new WP_Error( 'chinvat_forbidden', __( 'Insufficient capability.', 'chinvat-bridge' ) );
	}
	if ( $is_write && ! chinvat_bridge_writes_enabled() ) {
		return new WP_Error( 'chinvat_writes_disabled', __( 'Writes are disabled. Set CHINVAT_BRIDGE_ENABLE in wp-config.php.', 'chinvat-bridge' ) );
	}
	return true;
}

/**
 * Register all abilities.
 */
function chinvat_bridge_register_abilities(): void {
	if ( ! function_exists( 'wp_register_ability' ) ) {
		return;
	}

	// options-get.
	wp_register_ability(
		'chinvat-bridge/options-get',
		array(
			'label'               => __( 'Get option', 'chinvat-bridge' ),
			'description'         => __( 'Read a single wp_options value (denylist-guarded).', 'chinvat-bridge' ),
			'category'            => 'chinvat-options',
			'input_schema'        => array(
				'type'                 => 'object',
				'required'             => array( 'key' ),
				'additionalProperties' => false,
				'properties'           => array(
					'key' => array( 'type' => 'string', 'pattern' => '^[A-Za-z0-9_\\-]+$' ),
				),
			),
			'output_schema'       => array(
				'type'       => 'object',
				'properties' => array( 'key' => array( 'type' => 'string' ), 'value' => array() ),
			),
			'permission_callback' => static function ( $input ) {
				$g = chinvat_bridge_permit( 'manage_options', false );
				if ( is_wp_error( $g ) ) {
					return $g;
				}
				return chinvat_bridge_guard_option( (string) ( $input['key'] ?? '' ) );
			},
			'execute_callback'    => static function ( $input ) {
				$key = (string) $input['key'];
				return array( 'key' => $key, 'value' => get_option( $key, null ) );
			},
			'meta'                => array(
				'annotations'  => array( 'readonly' => true, 'destructive' => false, 'idempotent' => true ),
				'show_in_rest' => true,
			),
		)
	);

	// options-update.
	wp_register_ability(
		'chinvat-bridge/options-update',
		array(
			'label'               => __( 'Update option', 'chinvat-bridge' ),
			'description'         => __( 'Write a single wp_options value (denylist-guarded).', 'chinvat-bridge' ),
			'category'            => 'chinvat-options',
			'input_schema'        => array(
				'type'                 => 'object',
				'required'             => array( 'key', 'value' ),
				'additionalProperties' => false,
				'properties'           => array(
					'key'   => array( 'type' => 'string', 'pattern' => '^[A-Za-z0-9_\\-]+$' ),
					'value' => array( 'description' => 'scalar or JSON-serialisable value' ),
				),
			),
			'output_schema'       => array(
				'type'       => 'object',
				'properties' => array( 'key' => array( 'type' => 'string' ), 'updated' => array( 'type' => 'boolean' ) ),
			),
			'permission_callback' => static function ( $input ) {
				$g = chinvat_bridge_permit( 'manage_options', true );
				if ( is_wp_error( $g ) ) {
					return $g;
				}
				return chinvat_bridge_guard_option( (string) ( $input['key'] ?? '' ) );
			},
			'execute_callback'    => static function ( $input ) {
				$ok = update_option( (string) $input['key'], $input['value'] );
				return array( 'key' => (string) $input['key'], 'updated' => (bool) $ok );
			},
			'meta'                => array(
				'annotations'  => array( 'readonly' => false, 'destructive' => true, 'idempotent' => true ),
				'show_in_rest' => true,
			),
		)
	);

	// theme-list.
	wp_register_ability(
		'chinvat-bridge/theme-list',
		array(
			'label'               => __( 'List theme files', 'chinvat-bridge' ),
			'description'         => __( 'List files in the active theme (symlinks are not followed).', 'chinvat-bridge' ),
			'category'            => 'chinvat-theme',
			'input_schema'        => array( 'type' => 'object', 'additionalProperties' => false, 'properties' => array() ),
			'output_schema'       => array( 'type' => 'object', 'properties' => array( 'files' => array( 'type' => 'array' ) ) ),
			'permission_callback' => static function () {
				return chinvat_bridge_permit( 'edit_themes', false );
			},
			'execute_callback'    => static function () {
				$root  = wp_normalize_path( realpath( get_stylesheet_directory() ) );
				$files = array();
				if ( $root ) {
					$dir_it = new RecursiveDirectoryIterator( $root, FilesystemIterator::SKIP_DOTS );
					$filter = new RecursiveCallbackFilterIterator(
						$dir_it,
						static function ( $current ) {
							// Never descend into or list symlinks.
							return ! $current->isLink();
						}
					);
					$it = new RecursiveIteratorIterator( $filter );
					foreach ( $it as $f ) {
						if ( ! $f->isFile() || $f->isLink() ) {
							continue;
						}
						$rp = realpath( $f->getPathname() );
						$rp = $rp ? wp_normalize_path( $rp ) : '';
						if ( '' === $rp || 0 !== strpos( $rp . '/', $root . '/' ) ) {
							continue;
						}
						$files[] = ltrim( str_replace( $root, '', $rp ), '/' );
					}
					sort( $files );
				}
				return array( 'files' => $files );
			},
			'meta'                => array(
				'annotations'  => array( 'readonly' => true, 'destructive' => false, 'idempotent' => true ),
				'show_in_rest' => true,
			),
		)
	);

	// theme-read.
	wp_register_ability(
		'chinvat-bridge/theme-read',
		array(
			'label'               => __( 'Read theme file', 'chinvat-bridge' ),
			'description'         => __( 'Read a file from the active theme.', 'chinvat-bridge' ),
			'category'            => 'chinvat-theme',
			'input_schema'        => array(
				'type'                 => 'object',
				'required'             => array( 'path' ),
				'additionalProperties' => false,
				'properties'           => array( 'path' => array( 'type' => 'string' ) ),
			),
			'output_schema'       => array( 'type' => 'object', 'properties' => array( 'path' => array( 'type' => 'string' ), 'content' => array( 'type' => 'string' ) ) ),
			'permission_callback' => static function () {
				return chinvat_bridge_permit( 'edit_themes', false );
			},
			'execute_callback'    => static function ( $input ) {
				$abs = chinvat_bridge_resolve_theme_path( (string) $input['path'], true );
				if ( is_wp_error( $abs ) ) {
					return $abs;
				}
				return array( 'path' => (string) $input['path'], 'content' => (string) file_get_contents( $abs ) );
			},
			'meta'                => array(
				'annotations'  => array( 'readonly' => true, 'destructive' => false, 'idempotent' => true ),
				'show_in_rest' => true,
			),
		)
	);

	// theme-write (DANGEROUS).
	wp_register_ability(
		'chinvat-bridge/theme-write',
		array(
			'label'               => __( 'Write theme file', 'chinvat-bridge' ),
			'description'         => __( 'Write a file into the active theme, with confinement, PHP lint, backup and atomic write.', 'chinvat-bridge' ),
			'category'            => 'chinvat-theme',
			'input_schema'        => array(
				'type'                 => 'object',
				'required'             => array( 'path', 'content' ),
				'additionalProperties' => false,
				'properties'           => array(
					'path'    => array( 'type' => 'string' ),
					'content' => array( 'type' => 'string' ),
				),
			),
			'output_schema'       => array(
				'type'       => 'object',
				'properties' => array(
					'path'    => array( 'type' => 'string' ),
					'bytes'   => array( 'type' => 'integer' ),
					'backup'  => array( 'type' => 'string' ),
				),
			),
			'permission_callback' => static function () {
				return chinvat_bridge_permit( 'edit_themes', true );
			},
			'execute_callback'    => static function ( $input ) {
				$content = (string) $input['content'];
				$abs     = chinvat_bridge_resolve_theme_path( (string) $input['path'], false );
				if ( is_wp_error( $abs ) ) {
					return $abs;
				}
				$lint = chinvat_bridge_php_lint( $abs, $content );
				if ( is_wp_error( $lint ) ) {
					return $lint;
				}
				$backup = chinvat_bridge_backup( $abs );
				if ( is_wp_error( $backup ) ) {
					return $backup;
				}
				$bytes = chinvat_bridge_atomic_write( $abs, $content );
				if ( is_wp_error( $bytes ) ) {
					return $bytes;
				}
				return array( 'path' => (string) $input['path'], 'bytes' => (int) $bytes, 'backup' => (string) $backup );
			},
			'meta'                => array(
				'annotations'  => array( 'readonly' => false, 'destructive' => true, 'idempotent' => false ),
				'show_in_rest' => true,
			),
		)
	);

	// rankmath-get.
	wp_register_ability(
		'chinvat-bridge/rankmath-get',
		array(
			'label'               => __( 'Get RankMath SEO', 'chinvat-bridge' ),
			'description'         => __( 'Read RankMath SEO fields for a post.', 'chinvat-bridge' ),
			'category'            => 'chinvat-seo',
			'input_schema'        => array(
				'type'                 => 'object',
				'required'             => array( 'post_id' ),
				'additionalProperties' => false,
				'properties'           => array( 'post_id' => array( 'type' => 'integer' ) ),
			),
			'output_schema'       => array( 'type' => 'object' ),
			'permission_callback' => static function ( $input ) {
				$g = chinvat_bridge_permit( 'edit_posts', false );
				if ( is_wp_error( $g ) ) {
					return $g;
				}
				if ( ! defined( 'RANK_MATH_VERSION' ) && ! class_exists( 'RankMath' ) ) {
					return new WP_Error( 'chinvat_no_rankmath', __( 'RankMath is not active.', 'chinvat-bridge' ) );
				}
				return current_user_can( 'edit_post', (int) ( $input['post_id'] ?? 0 ) )
					? true
					: new WP_Error( 'chinvat_forbidden', __( 'Cannot edit this post.', 'chinvat-bridge' ) );
			},
			'execute_callback'    => static function ( $input ) {
				$id = (int) $input['post_id'];
				return array(
					'post_id'     => $id,
					'title'       => get_post_meta( $id, 'rank_math_title', true ),
					'description' => get_post_meta( $id, 'rank_math_description', true ),
					'focus_kw'    => get_post_meta( $id, 'rank_math_focus_keyword', true ),
					'robots'      => get_post_meta( $id, 'rank_math_robots', true ),
					'canonical'   => get_post_meta( $id, 'rank_math_canonical_url', true ),
				);
			},
			'meta'                => array(
				'annotations'  => array( 'readonly' => true, 'destructive' => false, 'idempotent' => true ),
				'show_in_rest' => true,
			),
		)
	);

	// rankmath-update.
	wp_register_ability(
		'chinvat-bridge/rankmath-update',
		array(
			'label'               => __( 'Update RankMath SEO', 'chinvat-bridge' ),
			'description'         => __( 'Update RankMath SEO fields for a post.', 'chinvat-bridge' ),
			'category'            => 'chinvat-seo',
			'input_schema'        => array(
				'type'                 => 'object',
				'required'             => array( 'post_id' ),
				'additionalProperties' => false,
				'properties'           => array(
					'post_id'     => array( 'type' => 'integer' ),
					'title'       => array( 'type' => 'string' ),
					'description' => array( 'type' => 'string' ),
					'focus_kw'    => array( 'type' => 'string' ),
					'robots'      => array( 'type' => 'string' ),
					'canonical'   => array( 'type' => 'string' ),
				),
			),
			'output_schema'       => array( 'type' => 'object', 'properties' => array( 'post_id' => array( 'type' => 'integer' ), 'updated' => array( 'type' => 'array' ) ) ),
			'permission_callback' => static function ( $input ) {
				$g = chinvat_bridge_permit( 'edit_posts', true );
				if ( is_wp_error( $g ) ) {
					return $g;
				}
				if ( ! defined( 'RANK_MATH_VERSION' ) && ! class_exists( 'RankMath' ) ) {
					return new WP_Error( 'chinvat_no_rankmath', __( 'RankMath is not active.', 'chinvat-bridge' ) );
				}
				return current_user_can( 'edit_post', (int) ( $input['post_id'] ?? 0 ) )
					? true
					: new WP_Error( 'chinvat_forbidden', __( 'Cannot edit this post.', 'chinvat-bridge' ) );
			},
			'execute_callback'    => static function ( $input ) {
				$id  = (int) $input['post_id'];
				$map = array(
					'title'       => 'rank_math_title',
					'description' => 'rank_math_description',
					'focus_kw'    => 'rank_math_focus_keyword',
					'robots'      => 'rank_math_robots',
					'canonical'   => 'rank_math_canonical_url',
				);
				$updated = array();
				foreach ( $map as $field => $meta_key ) {
					if ( isset( $input[ $field ] ) ) {
						update_post_meta( $id, $meta_key, sanitize_text_field( (string) $input[ $field ] ) );
						$updated[] = $field;
					}
				}
				return array( 'post_id' => $id, 'updated' => $updated );
			},
			'meta'                => array(
				'annotations'  => array( 'readonly' => false, 'destructive' => false, 'idempotent' => true ),
				'show_in_rest' => true,
			),
		)
	);

	// plugins-list.
	wp_register_ability(
		'chinvat-bridge/plugins-list',
		array(
			'label'               => __( 'List plugins', 'chinvat-bridge' ),
			'description'         => __( 'List installed plugins and their status.', 'chinvat-bridge' ),
			'category'            => 'chinvat-plugins',
			'input_schema'        => array( 'type' => 'object', 'additionalProperties' => false, 'properties' => array() ),
			'output_schema'       => array( 'type' => 'object', 'properties' => array( 'plugins' => array( 'type' => 'array' ) ) ),
			'permission_callback' => static function () {
				return chinvat_bridge_permit( 'activate_plugins', false );
			},
			'execute_callback'    => static function () {
				if ( ! function_exists( 'get_plugins' ) ) {
					require_once ABSPATH . 'wp-admin/includes/plugin.php';
				}
				$out = array();
				foreach ( get_plugins() as $file => $data ) {
					$out[] = array(
						'file'    => $file,
						'name'    => $data['Name'],
						'version' => $data['Version'],
						'active'  => is_plugin_active( $file ),
					);
				}
				return array( 'plugins' => $out );
			},
			'meta'                => array(
				'annotations'  => array( 'readonly' => true, 'destructive' => false, 'idempotent' => true ),
				'show_in_rest' => true,
			),
		)
	);

	// plugins-toggle.
	wp_register_ability(
		'chinvat-bridge/plugins-toggle',
		array(
			'label'               => __( 'Activate/deactivate plugin', 'chinvat-bridge' ),
			'description'         => __( 'Activate or deactivate an installed plugin (protected plugins refused).', 'chinvat-bridge' ),
			'category'            => 'chinvat-plugins',
			'input_schema'        => array(
				'type'                 => 'object',
				'required'             => array( 'file', 'action' ),
				'additionalProperties' => false,
				'properties'           => array(
					'file'   => array( 'type' => 'string' ),
					'action' => array( 'type' => 'string', 'enum' => array( 'activate', 'deactivate' ) ),
				),
			),
			'output_schema'       => array( 'type' => 'object', 'properties' => array( 'file' => array( 'type' => 'string' ), 'active' => array( 'type' => 'boolean' ) ) ),
			'permission_callback' => static function () {
				return chinvat_bridge_permit( 'activate_plugins', true );
			},
			'execute_callback'    => static function ( $input ) {
				if ( ! function_exists( 'activate_plugin' ) ) {
					require_once ABSPATH . 'wp-admin/includes/plugin.php';
				}
				$file = (string) $input['file'];
				if ( ! array_key_exists( $file, get_plugins() ) ) {
					return new WP_Error( 'chinvat_no_plugin', __( 'Unknown plugin file.', 'chinvat-bridge' ) );
				}
				// Refuse to deactivate security-critical plugins or the bridge itself.
				$protected = (array) apply_filters(
					'chinvat_bridge_protected_plugins',
					array(
						'wordfence/wordfence.php',
						'chinvat-bridge/chinvat-bridge.php',
					)
				);
				if ( 'deactivate' === $input['action'] && in_array( $file, $protected, true ) ) {
					return new WP_Error( 'chinvat_protected_plugin', __( 'Refusing to deactivate a protected plugin.', 'chinvat-bridge' ) );
				}
				if ( 'activate' === $input['action'] ) {
					$res = activate_plugin( $file );
					if ( is_wp_error( $res ) ) {
						return $res;
					}
				} else {
					deactivate_plugins( $file );
				}
				return array( 'file' => $file, 'active' => is_plugin_active( $file ) );
			},
			'meta'                => array(
				'annotations'  => array( 'readonly' => false, 'destructive' => true, 'idempotent' => true ),
				'show_in_rest' => true,
			),
		)
	);
}
