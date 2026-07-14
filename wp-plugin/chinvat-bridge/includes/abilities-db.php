<?php
/**
 * DB-layer abilities for Chinvat WP Bridge — the layer that wins at runtime.
 *
 * In a block/FSE theme, user Global Styles (wp_global_styles CPT) and
 * Site-Editor template/part overrides (wp_template / wp_template_part CPTs)
 * live in the database and override theme.json and template *files* at
 * render time. These abilities read/write/reset that DB layer so a style or
 * template change sticks on the first call, and reset makes the theme files
 * authoritative again.
 *
 * @package ChinvatBridge
 * @since 0.4.0
 */

declare( strict_types = 1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Register the DB-layer ability category.
 */
function chinvat_bridge_register_db_categories(): void {
	if ( ! function_exists( 'wp_register_ability_category' ) ) {
		return;
	}
	wp_register_ability_category(
		'chinvat-db',
		array(
			'label'       => __( 'DB Layer (Global Styles and Templates)', 'chinvat-bridge' ),
			'description' => __( 'Authoritative access to the database layer that overrides theme files at runtime.', 'chinvat-bridge' ),
		)
	);
}

/**
 * Find the user Global Styles post for the active theme. Never creates one.
 *
 * @return WP_Post|null
 */
function chinvat_bridge_find_global_styles_post() {
	$q = new WP_Query(
		array(
			'post_type'      => 'wp_global_styles',
			'post_status'    => array( 'publish' ),
			'posts_per_page' => 1,
			'orderby'        => 'date',
			'order'          => 'DESC',
			'no_found_rows'  => true,
			'tax_query'      => array( // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_tax_query
				array(
					'taxonomy' => 'wp_theme',
					'field'    => 'name',
					'terms'    => get_stylesheet(),
				),
			),
		)
	);
	return $q->posts ? $q->posts[0] : null;
}

/**
 * Clear theme-JSON caches after a DB-layer write. Best effort, version-guarded.
 */
function chinvat_bridge_flush_theme_json_cache(): void {
	if ( function_exists( 'wp_clean_theme_json_cache' ) ) {
		wp_clean_theme_json_cache();
	} elseif ( class_exists( 'WP_Theme_JSON_Resolver' ) && method_exists( 'WP_Theme_JSON_Resolver', 'clean_cached_data' ) ) {
		WP_Theme_JSON_Resolver::clean_cached_data();
	}
}

/**
 * Deep-merge two config arrays: associative keys merge recursively, lists and
 * scalars are replaced by the override.
 *
 * @param array $base Base config.
 * @param array $over Override config.
 * @return array
 */
function chinvat_bridge_deep_merge( array $base, array $over ): array {
	foreach ( $over as $k => $v ) {
		$is_assoc = is_array( $v ) && ( array() === $v || array_keys( $v ) !== range( 0, count( $v ) - 1 ) );
		if ( $is_assoc && isset( $base[ $k ] ) && is_array( $base[ $k ] ) ) {
			$base[ $k ] = chinvat_bridge_deep_merge( $base[ $k ], $v );
		} else {
			$base[ $k ] = $v;
		}
	}
	return $base;
}

/**
 * Resolve a block template/part for the active theme via the standard lookup
 * (DB override wins over theme file, matching runtime behaviour).
 *
 * @param string $type wp_template|wp_template_part.
 * @param string $slug Template slug.
 * @return WP_Block_Template|WP_Error
 */
function chinvat_bridge_get_block_template( string $type, string $slug ) {
	if ( ! function_exists( 'get_block_template' ) ) {
		return new WP_Error( 'chinvat_no_fse', __( 'Block template functions unavailable on this WordPress version.', 'chinvat-bridge' ) );
	}
	$t = get_block_template( get_stylesheet() . '//' . $slug, $type );
	if ( ! $t ) {
		/* translators: 1: post type, 2: slug. */
		return new WP_Error( 'chinvat_no_template', sprintf( __( 'No %1$s with slug "%2$s" resolves for the active theme.', 'chinvat-bridge' ), $type, $slug ) );
	}
	return $t;
}

/**
 * Insert/update a post with KSES suspended when the actor lacks
 * unfiltered_html, so block markup and Global Styles JSON are stored
 * verbatim rather than mangled. Gated upstream by permit + toggle.
 *
 * @param array $data   Unslashed post data.
 * @param bool  $update Update (true) or insert (false).
 * @return int|WP_Error
 */
function chinvat_bridge_write_post_unfiltered( array $data, bool $update ) {
	$suspended = false;
	if ( ! current_user_can( 'unfiltered_html' ) ) {
		kses_remove_filters();
		$suspended = true;
	}
	$r = $update ? chinvat_bridge_write_post_unfiltered( $data, true ) : wp_insert_post( wp_slash( $data ), true );
	if ( $suspended ) {
		kses_init_filters();
	}
	return $r;
}

/**
 * Register all DB-layer abilities.
 */
function chinvat_bridge_register_db_abilities(): void {
	if ( ! function_exists( 'wp_register_ability' ) ) {
		return;
	}

	$slug_pattern = '^[a-zA-Z0-9_\-]+$';
	$type_enum    = array( 'wp_template', 'wp_template_part' );

	$read_permit  = static function () {
		return chinvat_bridge_permit( 'edit_theme_options', false );
	};
	$write_permit = static function () {
		return chinvat_bridge_permit( 'edit_theme_options', true, 'db_layer' );
	};

	// db-state: lean editing-state read — which layer owns what.
	wp_register_ability(
		'chinvat-bridge/db-state',
		array(
			'label'               => __( 'DB layer state', 'chinvat-bridge' ),
			'description'         => __( 'Report which layer currently owns rendering: user Global Styles post, DB template/part overrides, active theme identity.', 'chinvat-bridge' ),
			'category'            => 'chinvat-db',
			'input_schema'        => array( 'type' => 'object', 'additionalProperties' => false, 'properties' => array() ),
			'output_schema'       => array( 'type' => 'object' ),
			'permission_callback' => $read_permit,
			'execute_callback'    => static function () {
				$gs        = chinvat_bridge_find_global_styles_post();
				$overrides = array(
					'wp_template'      => array(),
					'wp_template_part' => array(),
				);
				if ( function_exists( 'get_block_templates' ) ) {
					foreach ( array_keys( $overrides ) as $type ) {
						foreach ( get_block_templates( array(), $type ) as $t ) {
							if ( ! empty( $t->wp_id ) ) {
								$overrides[ $type ][] = array(
									'slug'           => $t->slug,
									'wp_id'          => (int) $t->wp_id,
									'has_theme_file' => ! empty( $t->has_theme_file ),
								);
							}
						}
					}
				}
				return array(
					'stylesheet'                 => get_stylesheet(),
					'template'                   => get_template(),
					'is_child'                   => get_stylesheet() !== get_template(),
					'global_styles'              => array(
						'db_override_exists' => (bool) $gs,
						'post_id'            => $gs ? (int) $gs->ID : null,
						'modified_gmt'       => $gs ? $gs->post_modified_gmt : null,
					),
					'db_template_overrides'      => $overrides['wp_template'],
					'db_template_part_overrides' => $overrides['wp_template_part'],
					'note'                       => 'DB overrides win over theme files at runtime. Use global-styles-reset / template-reset to make files authoritative again.',
				);
			},
			'meta'                => array(
				'annotations'  => array( 'readonly' => true, 'destructive' => false, 'idempotent' => true ),
				'show_in_rest' => true,
			),
		)
	);

	// global-styles-get.
	wp_register_ability(
		'chinvat-bridge/global-styles-get',
		array(
			'label'               => __( 'Get user Global Styles', 'chinvat-bridge' ),
			'description'         => __( 'Read the user Global Styles config (wp_global_styles post) for the active theme — the styles layer that overrides theme.json at runtime.', 'chinvat-bridge' ),
			'category'            => 'chinvat-db',
			'input_schema'        => array( 'type' => 'object', 'additionalProperties' => false, 'properties' => array() ),
			'output_schema'       => array( 'type' => 'object' ),
			'permission_callback' => $read_permit,
			'execute_callback'    => static function () {
				$post = chinvat_bridge_find_global_styles_post();
				if ( ! $post ) {
					return array(
						'exists' => false,
						'config' => null,
						'note'   => 'No user Global Styles override; theme.json is authoritative.',
					);
				}
				$config = json_decode( (string) $post->post_content, true );
				return array(
					'exists'       => true,
					'post_id'      => (int) $post->ID,
					'modified_gmt' => $post->post_modified_gmt,
					'config'       => is_array( $config ) ? $config : null,
				);
			},
			'meta'                => array(
				'annotations'  => array( 'readonly' => true, 'destructive' => false, 'idempotent' => true ),
				'show_in_rest' => true,
			),
		)
	);

	// global-styles-update.
	wp_register_ability(
		'chinvat-bridge/global-styles-update',
		array(
			'label'               => __( 'Update user Global Styles', 'chinvat-bridge' ),
			'description'         => __( 'Write the user Global Styles config (theme.json-shaped: settings/styles keys). merge=true deep-merges into the existing config; default replaces it. Creates the wp_global_styles post if absent.', 'chinvat-bridge' ),
			'category'            => 'chinvat-db',
			'input_schema'        => array(
				'type'                 => 'object',
				'required'             => array( 'styles' ),
				'additionalProperties' => false,
				'properties'           => array(
					'styles' => array( 'description' => 'theme.json-shaped config object, or a JSON string of one' ),
					'merge'  => array( 'type' => 'boolean', 'description' => 'deep-merge into existing config instead of replacing (default false)' ),
				),
			),
			'output_schema'       => array( 'type' => 'object' ),
			'permission_callback' => $write_permit,
			'execute_callback'    => static function ( $input ) {
				$raw = $input['styles'];
				if ( is_string( $raw ) ) {
					$decoded = json_decode( $raw, true );
				} elseif ( is_array( $raw ) ) {
					$decoded = $raw;
				} else {
					$decoded = null;
				}
				if ( ! is_array( $decoded ) ) {
					return new WP_Error( 'chinvat_bad_styles', __( 'styles must be a JSON object (or a JSON string of one).', 'chinvat-bridge' ) );
				}

				$post     = chinvat_bridge_find_global_styles_post();
				$existing = array();
				if ( $post ) {
					$prev = json_decode( (string) $post->post_content, true );
					if ( is_array( $prev ) ) {
						$existing = $prev;
					}
				}

				$merge  = ! empty( $input['merge'] );
				$config = $merge ? chinvat_bridge_deep_merge( $existing, $decoded ) : $decoded;

				// Required markers, else the resolver ignores the post.
				$config['isGlobalStylesUserThemeJSON'] = true;
				$config['version']                     = class_exists( 'WP_Theme_JSON' ) ? WP_Theme_JSON::LATEST_SCHEMA : 3;

				$json = wp_json_encode( $config );
				if ( false === $json ) {
					return new WP_Error( 'chinvat_encode', __( 'Could not encode config as JSON.', 'chinvat-bridge' ) );
				}

				if ( $post ) {
					$r = chinvat_bridge_write_post_unfiltered(
						array(
							'ID'           => $post->ID,
							'post_content' => $json,
						),
						true
					);
				} elseif ( class_exists( 'WP_Theme_JSON_Resolver' ) && method_exists( 'WP_Theme_JSON_Resolver', 'get_user_global_styles_post_id' ) ) {
					// Let core create the post with its own naming/taxonomy wiring.
					$pid = (int) WP_Theme_JSON_Resolver::get_user_global_styles_post_id();
					$r   = chinvat_bridge_write_post_unfiltered(
						array(
							'ID'           => $pid,
							'post_content' => $json,
						),
						true
					);
				} else {
					$r = chinvat_bridge_write_post_unfiltered(
						array(
							'post_type'    => 'wp_global_styles',
							'post_status'  => 'publish',
							'post_title'   => 'Custom Styles',
							'post_name'    => 'wp-global-styles-' . rawurlencode( get_stylesheet() ),
							'post_content' => $json,
						),
						false
					);
					if ( ! is_wp_error( $r ) ) {
						wp_set_object_terms( (int) $r, array( get_stylesheet() ), 'wp_theme', false );
					}
				}
				if ( is_wp_error( $r ) ) {
					return $r;
				}
				chinvat_bridge_flush_theme_json_cache();
				return array(
					'post_id' => (int) $r,
					'merged'  => $merge,
					'bytes'   => strlen( $json ),
				);
			},
			'meta'                => array(
				'annotations'  => array( 'readonly' => false, 'destructive' => false, 'idempotent' => true ),
				'show_in_rest' => true,
			),
		)
	);

	// global-styles-reset.
	wp_register_ability(
		'chinvat-bridge/global-styles-reset',
		array(
			'label'               => __( 'Reset user Global Styles', 'chinvat-bridge' ),
			'description'         => __( 'Remove the user Global Styles override so theme.json (files) becomes authoritative again. Trashes by default (recoverable); force=true deletes permanently.', 'chinvat-bridge' ),
			'category'            => 'chinvat-db',
			'input_schema'        => array(
				'type'                 => 'object',
				'additionalProperties' => false,
				'properties'           => array(
					'force' => array( 'type' => 'boolean', 'description' => 'permanently delete instead of trashing (default false)' ),
				),
			),
			'output_schema'       => array( 'type' => 'object' ),
			'permission_callback' => $write_permit,
			'execute_callback'    => static function ( $input ) {
				$post = chinvat_bridge_find_global_styles_post();
				if ( ! $post ) {
					return array(
						'reset' => false,
						'note'  => 'No user Global Styles override exists; theme.json is already authoritative.',
					);
				}
				$force = ! empty( $input['force'] );
				$r     = $force ? wp_delete_post( $post->ID, true ) : wp_trash_post( $post->ID );
				if ( ! $r ) {
					return new WP_Error( 'chinvat_reset_failed', __( 'Could not remove the Global Styles post.', 'chinvat-bridge' ) );
				}
				chinvat_bridge_flush_theme_json_cache();
				return array(
					'reset'   => true,
					'post_id' => (int) $post->ID,
					'trashed' => ! $force,
				);
			},
			'meta'                => array(
				'annotations'  => array( 'readonly' => false, 'destructive' => true, 'idempotent' => true ),
				'show_in_rest' => true,
			),
		)
	);

	// template-list.
	wp_register_ability(
		'chinvat-bridge/template-list',
		array(
			'label'               => __( 'List templates and parts', 'chinvat-bridge' ),
			'description'         => __( 'List all block templates and template parts for the active theme, with source (theme file vs DB override) per item.', 'chinvat-bridge' ),
			'category'            => 'chinvat-db',
			'input_schema'        => array( 'type' => 'object', 'additionalProperties' => false, 'properties' => array() ),
			'output_schema'       => array( 'type' => 'object', 'properties' => array( 'templates' => array( 'type' => 'array' ) ) ),
			'permission_callback' => $read_permit,
			'execute_callback'    => static function () {
				if ( ! function_exists( 'get_block_templates' ) ) {
					return new WP_Error( 'chinvat_no_fse', __( 'Block template functions unavailable on this WordPress version.', 'chinvat-bridge' ) );
				}
				$out = array();
				foreach ( array( 'wp_template', 'wp_template_part' ) as $type ) {
					foreach ( get_block_templates( array(), $type ) as $t ) {
						$out[] = array(
							'type'            => $type,
							'slug'            => $t->slug,
							'title'           => (string) $t->title,
							'source'          => $t->source,
							'has_db_override' => ! empty( $t->wp_id ),
							'has_theme_file'  => ! empty( $t->has_theme_file ),
							'wp_id'           => ! empty( $t->wp_id ) ? (int) $t->wp_id : null,
							'area'            => isset( $t->area ) ? $t->area : null,
						);
					}
				}
				return array( 'templates' => $out );
			},
			'meta'                => array(
				'annotations'  => array( 'readonly' => true, 'destructive' => false, 'idempotent' => true ),
				'show_in_rest' => true,
			),
		)
	);

	// template-get.
	wp_register_ability(
		'chinvat-bridge/template-get',
		array(
			'label'               => __( 'Get template or part', 'chinvat-bridge' ),
			'description'         => __( 'Read one block template or template part as it resolves at runtime (DB override wins over theme file).', 'chinvat-bridge' ),
			'category'            => 'chinvat-db',
			'input_schema'        => array(
				'type'                 => 'object',
				'required'             => array( 'type', 'slug' ),
				'additionalProperties' => false,
				'properties'           => array(
					'type' => array( 'type' => 'string', 'enum' => $type_enum ),
					'slug' => array( 'type' => 'string', 'pattern' => $slug_pattern ),
				),
			),
			'output_schema'       => array( 'type' => 'object' ),
			'permission_callback' => $read_permit,
			'execute_callback'    => static function ( $input ) {
				$t = chinvat_bridge_get_block_template( (string) $input['type'], (string) $input['slug'] );
				if ( is_wp_error( $t ) ) {
					return $t;
				}
				return array(
					'type'            => (string) $input['type'],
					'slug'            => $t->slug,
					'title'           => (string) $t->title,
					'source'          => $t->source,
					'has_db_override' => ! empty( $t->wp_id ),
					'has_theme_file'  => ! empty( $t->has_theme_file ),
					'wp_id'           => ! empty( $t->wp_id ) ? (int) $t->wp_id : null,
					'area'            => isset( $t->area ) ? $t->area : null,
					'content'         => (string) $t->content,
				);
			},
			'meta'                => array(
				'annotations'  => array( 'readonly' => true, 'destructive' => false, 'idempotent' => true ),
				'show_in_rest' => true,
			),
		)
	);

	// template-update.
	wp_register_ability(
		'chinvat-bridge/template-update',
		array(
			'label'               => __( 'Update template or part', 'chinvat-bridge' ),
			'description'         => __( 'Write block markup to the DB layer for a template or part — updates the existing DB override or creates one over the theme file. This is the write that actually renders.', 'chinvat-bridge' ),
			'category'            => 'chinvat-db',
			'input_schema'        => array(
				'type'                 => 'object',
				'required'             => array( 'type', 'slug', 'content' ),
				'additionalProperties' => false,
				'properties'           => array(
					'type'    => array( 'type' => 'string', 'enum' => $type_enum ),
					'slug'    => array( 'type' => 'string', 'pattern' => $slug_pattern ),
					'content' => array( 'type' => 'string', 'description' => 'block markup (HTML comments syntax)' ),
					'title'   => array( 'type' => 'string' ),
					'area'    => array( 'type' => 'string', 'description' => 'template parts only: header|footer|uncategorized (default uncategorized; ignored on update)' ),
				),
			),
			'output_schema'       => array( 'type' => 'object' ),
			'permission_callback' => $write_permit,
			'execute_callback'    => static function ( $input ) {
				$type    = (string) $input['type'];
				$slug    = (string) $input['slug'];
				$content = (string) $input['content'];

				$existing_id = 0;
				if ( function_exists( 'get_block_template' ) ) {
					$t = get_block_template( get_stylesheet() . '//' . $slug, $type );
					if ( $t && ! empty( $t->wp_id ) ) {
						$existing_id = (int) $t->wp_id;
					}
				}

				if ( $existing_id ) {
					$data = array(
						'ID'           => $existing_id,
						'post_content' => $content,
					);
					if ( isset( $input['title'] ) && '' !== (string) $input['title'] ) {
						$data['post_title'] = (string) $input['title'];
					}
					$r = wp_update_post( wp_slash( $data ), true );
					if ( is_wp_error( $r ) ) {
						return $r;
					}
					return array(
						'wp_id'  => $existing_id,
						'action' => 'updated',
						'type'   => $type,
						'slug'   => $slug,
					);
				}

				$title = ( isset( $input['title'] ) && '' !== (string) $input['title'] ) ? (string) $input['title'] : $slug;
				$r     = chinvat_bridge_write_post_unfiltered(
					array(
						'post_type'    => $type,
						'post_status'  => 'publish',
						'post_name'    => $slug,
						'post_title'   => $title,
						'post_content' => $content,
					),
					false
				);
				if ( is_wp_error( $r ) ) {
					return $r;
				}
				$pid = (int) $r;
				wp_set_object_terms( $pid, array( get_stylesheet() ), 'wp_theme', false );
				if ( 'wp_template_part' === $type ) {
					$area = ( isset( $input['area'] ) && '' !== (string) $input['area'] ) ? sanitize_key( (string) $input['area'] ) : 'uncategorized';
					if ( ! in_array( $area, array( 'header', 'footer', 'sidebar', 'uncategorized' ), true ) ) {
						$area = 'uncategorized';
					}
					wp_set_object_terms( $pid, array( $area ), 'wp_template_part_area', false );
				}
				return array(
					'wp_id'  => $pid,
					'action' => 'created',
					'type'   => $type,
					'slug'   => $slug,
				);
			},
			'meta'                => array(
				'annotations'  => array( 'readonly' => false, 'destructive' => false, 'idempotent' => true ),
				'show_in_rest' => true,
			),
		)
	);

	// template-reset.
	wp_register_ability(
		'chinvat-bridge/template-reset',
		array(
			'label'               => __( 'Reset template or part', 'chinvat-bridge' ),
			'description'         => __( 'Remove the DB override for a template or part so the theme file becomes authoritative again. Trashes by default (recoverable); force=true deletes permanently.', 'chinvat-bridge' ),
			'category'            => 'chinvat-db',
			'input_schema'        => array(
				'type'                 => 'object',
				'required'             => array( 'type', 'slug' ),
				'additionalProperties' => false,
				'properties'           => array(
					'type'  => array( 'type' => 'string', 'enum' => $type_enum ),
					'slug'  => array( 'type' => 'string', 'pattern' => $slug_pattern ),
					'force' => array( 'type' => 'boolean', 'description' => 'permanently delete instead of trashing (default false)' ),
				),
			),
			'output_schema'       => array( 'type' => 'object' ),
			'permission_callback' => $write_permit,
			'execute_callback'    => static function ( $input ) {
				$type = (string) $input['type'];
				$slug = (string) $input['slug'];
				$t    = chinvat_bridge_get_block_template( $type, $slug );
				if ( is_wp_error( $t ) ) {
					return $t;
				}
				if ( empty( $t->wp_id ) ) {
					return array(
						'reset' => false,
						'note'  => 'No DB override exists; the theme file is already authoritative.',
					);
				}
				$force = ! empty( $input['force'] );
				$r     = $force ? wp_delete_post( (int) $t->wp_id, true ) : wp_trash_post( (int) $t->wp_id );
				if ( ! $r ) {
					return new WP_Error( 'chinvat_reset_failed', __( 'Could not remove the template override post.', 'chinvat-bridge' ) );
				}
				return array(
					'reset'          => true,
					'wp_id'          => (int) $t->wp_id,
					'trashed'        => ! $force,
					'has_theme_file' => ! empty( $t->has_theme_file ),
					'note'           => ! empty( $t->has_theme_file )
						? 'Theme file now renders for this slug.'
						: 'No theme file backs this slug; it no longer resolves.',
				);
			},
			'meta'                => array(
				'annotations'  => array( 'readonly' => false, 'destructive' => true, 'idempotent' => true ),
				'show_in_rest' => true,
			),
		)
	);
}
